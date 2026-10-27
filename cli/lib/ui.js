// Terminal renderer, styled after Claude Code's own CLI output: a bullet ("●") per
// action/thought, tool calls shown as discrete "Name(args)" lines with an indented
// "⎿" result underneath, rather than dumping the model's raw chat text verbatim.
const screen = require('./screen');

const codes = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function paint(code, text) {
  if (!process.stdout.isTTY) return text;
  return `${codes[code]}${text}${codes.reset}`;
}

function visibleLength(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
}

// Border characters are colored individually (not the whole multi-line block wrapped in one
// paint() call) so an inner line's own paint()-and-reset doesn't clip the border color for
// every line that follows it.
function box(lines) {
  const innerWidth = Math.max(0, ...lines.map(visibleLength)) + 2;
  const border = paint('cyan', '─'.repeat(innerWidth));
  const edge = paint('cyan', '│');
  const top = `${paint('cyan', '╭')}${border}${paint('cyan', '╮')}`;
  const bottom = `${paint('cyan', '╰')}${border}${paint('cyan', '╯')}`;
  const body = lines.map((l) => {
    const pad = Math.max(0, innerWidth - 1 - visibleLength(l));
    return `${edge} ${l}${' '.repeat(pad)}${edge}`;
  });
  return [top, ...body, bottom].join('\n');
}

// !TOOL lines and [SUBTASK]/[MEMORY_UPDATE] blocks are rendered as their own structured
// cards elsewhere (tool_call/tool_call_result/subtask_started messages) — stripped here
// so the reasoning text shown alongside them isn't a duplicate wall of the same content.
const TOOL_LINE_RE = /^!\s*(READ_FILE|WRITE_FILE|EDIT_FILE|SHELL|SHELL_BG|PROC_LIST|PROC_LOG|PROC_KILL|GREP|FIND_FILE|LS|SEARCH_WEB|ASK_USER|DELETE_FILE|OPEN_APP|HTTP_GET)\b.*$/;
const BLOCK_RE = /\[(SUBTASK|MEMORY_UPDATE|PLAN)(?:\s[^\]]*)?\][\s\S]*?\[\/\1\]/g;
const FENCE_RE = /```[\s\S]*?```/g;

function stripStructured(text) {
  return String(text || '')
    .replace(BLOCK_RE, '')
    .replace(FENCE_RE, (m) => (m.length > 200 ? '[code block omitted — see tool card above]' : m))
    .split('\n')
    .filter((line) => !TOOL_LINE_RE.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MAX_LINES = 6;
const MAX_CHARS = 2000;

// A short ring of recently truncated full texts — Claude-Code-style "ctrl+o to expand"
// reprints these on demand instead of forcing a re-run just to see the rest of a long tool
// result, diff, or code block. Repeated ctrl+o presses step further back (most recent
// first); any new truncation resets the cursor so the next press always starts from the
// latest collapse again, matching what you'd actually want to expand first.
const EXPAND_HISTORY_MAX = 5;
let expandHistory = [];
let expandCursor = -1;

function registerTruncation(fullText) {
  expandHistory.unshift(fullText);
  if (expandHistory.length > EXPAND_HISTORY_MAX) expandHistory.length = EXPAND_HISTORY_MAX;
  expandCursor = -1;
}

// Long output (a big file read, a wall of shell output, generated code) gets cut down to a
// fixed number of lines — like Claude Code's own "… +44 lines" collapse — rather than
// flooding the scrolling region above the pinned input box. Reports exactly how many lines
// were cut, not just "(truncated)", so it's clear how much more there is.
function truncate(text) {
  const original = String(text);
  const allLines = original.split('\n');
  let t = original;
  let truncated = false;
  let cutLines = 0;

  if (allLines.length > MAX_LINES) {
    cutLines = allLines.length - MAX_LINES;
    t = allLines.slice(0, MAX_LINES).join('\n');
    truncated = true;
  }
  if (t.length > MAX_CHARS) {
    t = t.slice(0, MAX_CHARS);
    truncated = true;
  }
  if (!truncated) return t;

  registerTruncation(original);
  const suffix = cutLines
    ? `… +${cutLines} line${cutLines === 1 ? '' : 's'} (ctrl+o to expand)`
    : `… (truncated — ctrl+o to expand)`;
  return `${t}\n${paint('gray', suffix)}`;
}

function indent(text, prefix = '  ') {
  return String(text || '')
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

const TOOL_LABELS = {
  READ_FILE: (p) => `Read(${p.path})`,
  WRITE_FILE: (p) => `Write(${p.path})`,
  SHELL: (p) => `Bash(${p.command})`,
  GREP: (p) => `Grep(${p.pattern}${p.path && p.path !== '.' ? ` in ${p.path}` : ''})`,
  FIND_FILE: (p) => `Find(${p.glob})`,
  LS: (p) => `List(${p.path || '.'})`,
  SEARCH_WEB: (p) => `Search(${p.query})`,
  DELETE_FILE: (p) => `Delete(${p.path})`,
  OPEN_APP: (p) => `Open(${p.command})`,
  HTTP_GET: (p) => `Fetch(${p.url})`,
  EDIT_FILE: (p) => `Edit(${p.path})`,
  SHELL_BG: (p) => `Bash&(${p.command})`,
  PROC_LIST: () => `ProcList()`,
  PROC_LOG: (p) => `ProcLog(${p.id}${p.lines ? ` ${p.lines}` : ''})`,
  PROC_KILL: (p) => `ProcKill(${p.id})`,
};

function toolLabel(tool, params) {
  const fn = TOOL_LABELS[tool];
  const label = fn ? fn(params || {}) : `${tool}(${JSON.stringify(params || {})})`;
  return label.length > 140 ? `${label.slice(0, 140)}…` : label;
}

// Small line-based diff (Myers/LCS via DP) — no dependency, since this project deliberately
// stays on just commander/ws/uuid. O(n*m); guarded against huge files below.
const DIFF_MAX_CELLS = 250000; // e.g. ~500x500 lines
const DIFF_CONTEXT_LINES = 1;

function diffLines(oldStr, newStr) {
  const a = String(oldStr).split('\n');
  const b = String(newStr).split('\n');
  if (a.length * b.length > DIFF_MAX_CELLS) return null;

  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'ctx', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', line: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', line: a[i++] });
  while (j < m) ops.push({ type: 'add', line: b[j++] });
  return ops;
}

// Collapses long unchanged runs down to a single "… N unchanged lines …" marker, keeping a
// little context around each change. With cap=true (the normal case) also caps total output
// so a huge file write can't flood the terminal, registering the uncapped render so ctrl+o
// can still reach the rest.
function renderDiffOps(ops, cap = true) {
  const n = ops.length;
  const keep = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (ops[i].type !== 'ctx') {
      for (let k = Math.max(0, i - DIFF_CONTEXT_LINES); k <= Math.min(n - 1, i + DIFF_CONTEXT_LINES); k++) keep[k] = true;
    }
  }
  const lines = [];
  let i = 0;
  let shown = 0;
  let truncated = false;
  while (i < n) {
    if (!keep[i]) {
      let j = i;
      while (j < n && !keep[j]) j++;
      lines.push(paint('gray', `  … ${j - i} unchanged line(s) …`));
      i = j;
      continue;
    }
    if (cap && shown >= MAX_LINES) {
      truncated = true;
      break;
    }
    const op = ops[i];
    if (op.type === 'add') lines.push(paint('green', `+ ${op.line}`));
    else if (op.type === 'del') lines.push(paint('red', `- ${op.line}`));
    else lines.push(paint('gray', `  ${op.line}`));
    shown++;
    i++;
  }
  if (truncated) {
    registerTruncation(renderDiffOps(ops, false));
    lines.push(paint('gray', '  … (diff truncated — ctrl+o to expand)'));
  }
  return lines.join('\n');
}

function renderWriteDiff(oldContent, newContent) {
  const content = newContent == null ? '' : String(newContent);
  if (oldContent == null) {
    const lines = content.split('\n');
    const shown = lines.slice(0, MAX_LINES);
    const body = shown.map((l) => paint('green', `+ ${l}`)).join('\n');
    let suffix = '';
    if (lines.length > MAX_LINES) {
      registerTruncation(lines.map((l) => paint('green', `+ ${l}`)).join('\n'));
      suffix = `\n${paint('gray', `  … +${lines.length - MAX_LINES} more line(s) (ctrl+o to expand)`)}`;
    }
    return `${paint('gray', '(new file)')}\n${body}${suffix}`;
  }
  if (oldContent === content) return paint('gray', '(no change)');
  const ops = diffLines(oldContent, content);
  if (!ops) {
    const oldLines = oldContent.split('\n').length;
    const newLines = content.split('\n').length;
    return paint('gray', `(file too large to diff — ${oldLines} → ${newLines} lines)`);
  }
  return renderDiffOps(ops);
}

function summarizeResult(tool, result) {
  if (result == null) return '(no output)';
  if (tool === 'SHELL' && typeof result === 'object') {
    const out = `${result.stdout || ''}${result.stderr || ''}`.trim();
    const status = result.exitCode === 0 ? paint('green', `exit 0`) : paint('red', `exit ${result.exitCode}`);
    return out ? `${status}\n${truncate(out)}` : status;
  }
  if (typeof result === 'string') return truncate(result);
  if (typeof result === 'object') {
    if (Array.isArray(result)) return truncate(result.join('\n'));
    return truncate(JSON.stringify(result, null, 2));
  }
  return truncate(String(result));
}

const ROLE_ICON = { planner: paint('blue', '●'), executor: paint('magenta', '●') };
const ROLE_NAME = { planner: paint('blue', 'Planner'), executor: paint('magenta', 'Executor') };

// Live "waiting on the model" indicator — the DeepSeek response can take a long time
// (content.js's inactivity-based detection has a 10-minute absolute ceiling), and without
// this the terminal just sits silent with no sign anything is happening. Not shown outside
// a real TTY (piped/test-harness stdout) so captured logs stay clean.
//
// Styled after Claude Code's own CLI: a rotating whimsical verb plus a live elapsed-seconds
// counter ("✻ Percolating (Planner) for 12s…") rather than a fast braille spinner glyph — the
// verb is picked once per wait (not re-rolled every tick) and the number is what actually
// communicates "still alive, still waiting," updated once a second instead of every 80ms.
const THINKING_VERBS = [
  'Pondering', 'Brewing', 'Cooking', 'Churning', 'Crunching', 'Cogitating',
  'Baking', 'Sautéing', 'Working', 'Mulling', 'Noodling', 'Percolating',
];
const SPINNER_INTERVAL_MS = 1000;
let spinnerTimer = null;
let spinnerVerb = null;
let spinnerStartedAt = 0;

function clearSpinner() {
  if (!spinnerTimer) return;
  clearInterval(spinnerTimer);
  spinnerTimer = null;
  if (process.stdout.isTTY) screen.status('');
}

function terminalWidth() {
  const w = screen.active ? screen.cols : process.stdout.columns;
  return w && w > 20 ? w : 80;
}

// Every line the CLI prints funnels through here, into the scrolling region above the
// pinned input box (see screen.js) — this is the direct replacement for console.log/warn/
// error, keeping the exact same call sites but routing to the right sink.
function out(...args) {
  screen.print(args.map(String).join(' '));
}

const ui = {
  // No-op now — was a standalone divider marking the start of a new exchange, back when the
  // box lived in an alt-screen region confined away from scrollback (see screen.js's
  // top-of-file comment for why that changed). Left in place (rather than deleted from every
  // call site) purely so those call sites still read as "a new exchange starts here"; kept
  // as a real no-op rather than removed because printing a rule here now, immediately above
  // the box's OWN top rule, produced a visible doubled divider — observed live (2026-08-15).
  inputRule() {},

  // Claude Code's own bottom status bar ("⏸ manual mode on / ? for shortcuts") lives right
  // under its input box and never scrolls away — same here: this sets the screen's pinned
  // hint line instead of printing into scrollback, so it's always visible regardless of how
  // much output has streamed by.
  statusLine(approveAll) {
    if (!process.stdout.isTTY) return;
    const icon = approveAll ? '⏵⏵' : '⏸';
    const label = approveAll ? 'auto-approve all' : 'manual approval';
    screen.setHint(paint('dim', `  ${icon} ${label} (shift+tab to cycle) · ctrl+o expand output · "exit" to quit`));
  },

  // Shown once, right when the CLI starts (like Claude Code's own welcome box) — skipped
  // entirely outside a real TTY so it never pollutes piped/captured output (test harnesses,
  // --history, etc.). Prints into the scrolling region same as everything else, so it
  // naturally scrolls out of view as the conversation grows — only the input box stays put.
  banner() {
    if (!process.stdout.isTTY) return;
    const lines = [
      `${paint('bold', paint('cyan', '✻'))} ${paint('bold', 'MyClaudeCode')}`,
      paint('dim', 'Free AI coding agent — planner + executor, powered by DeepSeek chat'),
      '',
      paint('dim', `cwd: ${process.cwd()}`),
    ];
    out();
    out(box(lines));
    out();
  },

  // Echoes what the user just submitted into the scrolling history, since it disappears
  // from the pinned input box the instant Enter is pressed — same reason Claude Code shows
  // your own message in the transcript rather than just clearing the box silently.
  userLine: (text) => {
    if (!text) return;
    out(paint('bold', '❯ ') + text);
  },

  info: (msg) => out(paint('cyan', '●'), msg),
  success: (msg) => out(paint('green', '●'), paint('bold', msg)),
  error: (msg) => out(paint('red', '●'), paint('red', msg)),
  warn: (msg) => out(paint('yellow', '●'), msg),
  debug: (msg) => out(paint('gray', `[debug] ${msg}`)),

  // Planner/executor reasoning text — dimmed, structured markup stripped, truncated.
  reasoning(role, text) {
    const cleaned = stripStructured(text);
    if (!cleaned) return;
    out(`${ROLE_ICON[role] || '●'} ${ROLE_NAME[role] || role}`);
    out(paint('dim', indent(truncate(cleaned))));
  },

  subtaskStarted(subtask) {
    out(paint('bold', paint('cyan', '● Subtask assigned')));
    out(paint('dim', indent(truncate(subtask))));
  },

  // Running checklist of subtasks dispatched so far this task, Claude-Code-TodoWrite style
  // — we only ever know the current/past ones (the planner reveals one at a time), not a
  // fixed upfront plan, so this is a history-so-far view rather than a full plan.
  todoList(items) {
    if (!items || !items.length) return;
    out(paint('bold', '● Progress'));
    for (const item of items) {
      const oneLine = String(item.text || '').replace(/\s+/g, ' ').trim();
      const label = oneLine.length > 100 ? `${oneLine.slice(0, 100)}…` : oneLine;
      if (item.status === 'done') {
        out(`  ${paint('green', '☒')} ${paint('dim', label)}`);
      } else if (item.status === 'failed') {
        out(`  ${paint('red', '✗')} ${paint('dim', label)}`);
      } else {
        out(`  ${paint('cyan', '▶')} ${paint('bold', label)}`);
      }
    }
  },

  toolCall(role, tool, params) {
    out(`${ROLE_ICON[role] || '●'} ${toolLabel(tool, params)}`);
  },

  toolResult(role, tool, params, result, error, extra = {}) {
    if (error) {
      out(paint('red', `  ⎿  Error: ${error}`));
      return;
    }
    const body =
      tool === 'WRITE_FILE' || tool === 'EDIT_FILE'
        ? `${typeof result === 'string' ? result : 'File written.'}\n${renderWriteDiff(extra.oldContent, extra.newContent)}`
        : summarizeResult(tool, result);
    const lines = body.split('\n');
    out(paint('gray', `  ⎿  ${lines[0]}`));
    for (const line of lines.slice(1)) out(`     ${line}`);
  },

  // Cost/turn visibility (readme.md section 13-adjacent gap: nothing surfaced how many
  // turns/tool calls a task actually burned) — printed once, right after the final outcome,
  // so a long or looping task is visible in its cost, not just its pass/fail result.
  stats(stats) {
    if (!stats) return;
    out(paint('dim', `  (${stats.plannerTurns} planner turn(s), ${stats.executorTurns} executor turn(s), ${stats.toolCalls} tool call(s))`));
  },

  taskCompleted(summary) {
    const cleaned = stripStructured(summary) || 'Task completed.';
    out(paint('green', '● Task completed'));
    out(paint('bold', indent(cleaned)));
  },

  startThinking(role) {
    clearSpinner();
    if (!process.stdout.isTTY) return;
    const label = ROLE_NAME[role] || role || 'Agent';
    spinnerVerb = THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];
    spinnerStartedAt = Date.now();
    const tick = () => {
      const secs = Math.max(0, Math.round((Date.now() - spinnerStartedAt) / 1000));
      screen.status(paint('gray', `✻ ${spinnerVerb} (${label}) for ${secs}s…`));
    };
    tick();
    spinnerTimer = setInterval(tick, SPINNER_INTERVAL_MS);
  },

  stopThinking: () => clearSpinner(),

  // DeepSeek rate limit: live "retrying in mm:ss" in the spinner slot until the retry
  // (the next THINKING_STARTED replaces it).
  rateLimitCountdown(role, retryAt, attempt, maxRetries) {
    clearSpinner();
    const label = ROLE_NAME[role] || role || 'Agent';
    const mins = Math.max(1, Math.round((retryAt - Date.now()) / 60000));
    out(paint('yellow', '●'), `DeepSeek rate limit on ${label} — retrying on the same tab every ${mins} min (attempt ${attempt}/${maxRetries}).`);
    if (!process.stdout.isTTY) return;
    const tick = () => {
      const left = Math.max(0, Math.round((retryAt - Date.now()) / 1000));
      const mm = String(Math.floor(left / 60)).padStart(2, '0');
      const ss = String(left % 60).padStart(2, '0');
      screen.status(paint('yellow', `⏳ Rate limited (${label}) — retrying in ${mm}:${ss}`));
    };
    tick();
    spinnerTimer = setInterval(tick, SPINNER_INTERVAL_MS);
  },

  gatePass: () => out(paint('green', '● Quality gates passed.')),
  gate: (gate, output) => {
    out(paint('yellow', `● Quality gate failed: ${gate}`));
    if (output) out(paint('dim', indent(truncate(output))));
  },

  approvalPrompt: (description, { matchedWord, cwd } = {}) => {
    out(paint('yellow', '● Approval required'));
    out(paint('bold', indent(description)));
    if (matchedWord) out(paint('dim', indent(`matched dangerous command: "${matchedWord}"`)));
    if (cwd) out(paint('dim', indent(`cwd: ${cwd}`)));
  },

  continueRecap(entries, limit = 10) {
    if (!entries.length) {
      out(paint('gray', 'No previous activity for this project — starting fresh.'));
      out();
      return;
    }
    const shown = entries.slice(-limit);
    out(paint('dim', `Continuing previous session (${shown.length} of ${entries.length} past task(s)):`));
    out();
    for (const entry of shown) {
      const taskText = String(entry.task || '(unknown task)').replace(/\s+/g, ' ').trim();
      out(paint('bold', '❯ ') + (taskText.length > 160 ? `${taskText.slice(0, 160)}…` : taskText));
      const ok = entry.status === 'completed';
      const detail = stripStructured((ok ? entry.summary : entry.message) || '') || (ok ? 'Task completed.' : 'Task failed.');
      out(ok ? paint('green', '●') : paint('red', '●'), paint('dim', indent(truncate(detail)).trimStart()));
      out();
    }
    out(paint('dim', '─'.repeat(Math.min(terminalWidth(), 60))));
    out();
  },

  historyList(entries, limit = 20) {
    if (!entries.length) {
      out(paint('gray', 'No past task runs recorded for this project yet.'));
      return;
    }
    const shown = entries.slice(-limit).reverse();
    out(paint('bold', `● Task history (${shown.length} of ${entries.length})`));
    for (const entry of shown) {
      const icon = entry.status === 'completed' ? paint('green', '☒') : paint('red', '✗');
      const when = entry.startedAt ? new Date(entry.startedAt).toLocaleString() : '(unknown time)';
      let duration = '';
      if (entry.startedAt && entry.endedAt) {
        const ms = new Date(entry.endedAt) - new Date(entry.startedAt);
        duration = Number.isFinite(ms) && ms >= 0 ? ` (${(ms / 1000).toFixed(1)}s)` : '';
      }
      const taskText = String(entry.task || '(unknown task)').replace(/\s+/g, ' ').trim();
      const label = taskText.length > 100 ? `${taskText.slice(0, 100)}…` : taskText;
      out(`  ${icon} ${paint('dim', when)}${paint('dim', duration)}  ${label}`);
      const detail = entry.status === 'completed' ? entry.summary : entry.message;
      if (detail) {
        const cleaned = stripStructured(detail);
        if (cleaned) out(paint('dim', indent(truncate(cleaned), '      ')));
      }
    }
  },

  // Claude Code style: numbered choices when the agent offers options, plus an implicit
  // "Other" (typing anything besides a listed number is taken as a free-text answer) —
  // or just a plain open question when it didn't offer any.
  question: (question, options) => {
    out(paint('cyan', '● Question'));
    out(paint('bold', indent(question)));
    if (options && options.length) {
      options.forEach((opt, i) => out(paint('dim', `    ${i + 1}. ${opt}`)));
      out(paint('dim', `  ↑↓ to choose, Enter to confirm — or type a number/your own answer:`));
    }
  },

  // The live "which option is currently highlighted" line — cli/index.js redraws this (via
  // screen.status, the same transient box-area slot the thinking spinner uses) on every
  // up/down arrow press instead of reprinting the whole option list into scrollback each
  // time, which would spam the conversation history with one line per keystroke. This is the
  // closest a plain terminal gets to "clickable" options: arrow to highlight, Enter to pick.
  optionSelector: (options, index, total) =>
    `${paint('cyan', `  ↑↓ ${index + 1}/${total}`)}  ${paint('bold', paint('cyan', `❯ ${options[index]}`))}`,

  // Bound to ctrl+o in cli/index.js — reprints whatever a "… +N lines" / "(diff truncated)"
  // collapse cut off, in full, instead of making the user re-run the task just to see the
  // rest of a long file/diff/shell output. Pressing it again steps further back through the
  // last few collapses (oldest kept: EXPAND_HISTORY_MAX); any new truncation resets back to
  // the newest one.
  expandLast: () => {
    if (!expandHistory.length) {
      out(paint('gray', '(nothing truncated yet)'));
      return;
    }
    expandCursor = Math.min(expandCursor + 1, expandHistory.length - 1);
    const position = `${expandCursor + 1}/${expandHistory.length}`;
    const more = expandCursor < expandHistory.length - 1 ? ' — ctrl+o again for older' : ' (oldest kept)';
    out(paint('bold', paint('cyan', `● Expanded (${position})${paint('dim', more)}`)));
    out(indent(expandHistory[expandCursor]));
  },

  phaseStarted: (name, index, total) => {
    out(paint('cyan', '●'), paint('bold', `Phase ${index}/${total}: ${name}`));
  },

  phaseSuccess: (name, durationMs, filesTouched) => {
    const secs = (durationMs / 1000).toFixed(1);
    out(paint('green', '●'), paint('bold', `Phase complete: ${name}`), paint('dim', `(${secs}s)`));
    if (filesTouched && filesTouched.length) {
      out(paint('dim', `  wrote: ${filesTouched.join(', ')}`));
    }
  },

  phaseFailed: (name, attempts, traceback) => {
    out(paint('red', '●'), paint('bold', `Phase failed: ${name}`), paint('dim', `after ${attempts} attempt(s)`));
    if (traceback) out(paint('dim', indent(truncate(traceback))));
  },

  directMode: (estimate) => {
    out(paint('cyan', '●'), `Direct mode (est. ${estimate} LOC)`);
  },

  escalated: (reason, filesTouched) => {
    out(paint('yellow', '●'), paint('bold', 'Direct mode failed — escalating to phased'));
    if (reason) out(paint('dim', indent(reason)));
    if (filesTouched && filesTouched.length) {
      out(paint('dim', indent(`files already touched: ${filesTouched.join(', ')}`)));
    }
  },

  attentionItem: (item) => {
    const severity = (item && item.severity) || 'medium';
    const color = severity === 'critical' ? 'red' : severity === 'high' ? 'yellow' : 'gray';
    out(paint(color, '●'), paint('bold', `[${severity}]`), (item && item.detail) || '(no detail)');
  },

  migrated: (role, reason, mode, bundleChars) => {
    out(paint('cyan', '●'), `Migrated ${role} tab (${reason}, ${mode} bundle, ${bundleChars} chars)`);
  },

  bundleTooLarge: (chars, threshold) => {
    out(paint('yellow', '●'), `Bundle too large: ${chars} chars (threshold ${threshold})`);
  },

  exclusionRoundStarted: () => {
    out(paint('cyan', '●'), 'Exclusion round started');
  },

  exclusionRoundDone: (round, chars, stillTooLarge) => {
    const suffix = stillTooLarge ? ' — still too large' : '';
    out(paint('cyan', '●'), `Exclusion round ${round} done: ${chars} chars${suffix}`);
  },
};

module.exports = ui;
