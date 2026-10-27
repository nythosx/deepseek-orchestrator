#!/usr/bin/env node
const path = require('path');
const readline = require('readline');
const { PassThrough } = require('stream');
const { Command } = require('commander');
const { v4: uuidv4 } = require('uuid');

const { ensureProjectConfig } = require('./lib/config');
const { startServer, cleanupPortFile } = require('./lib/server');
const { appendHistoryEntry, readHistory } = require('./lib/history');
const { makeLogger, logPath } = require('./lib/logger');
const ui = require('./lib/ui');
const screen = require('./lib/screen');
const { CLI_MESSAGE_TYPES } = require('../shared/protocol');

const program = new Command();
program
  .name('deeper')
  .argument('[task]', 'high-level instruction for the agent (omit to connect and be prompted interactively)')
  .option('--approve-all', 'skip all manual approval prompts', false)
  .option('--disable-web-search', 'prevent the AI from using web search', false)
  .option('--deep-think', 'enable DeepSeek\'s DeepThink reasoning mode (legacy: both tabs; phased: brain on, coder off by default)')
  .option('--no-deep-think', 'disable DeepThink on both tabs')
  .option('--phased', 'phased mode (default; kept as an explicit flag for backward compat — no-op)', false)
  .option('--legacy', 'use the legacy v1 planner/executor workflow instead of the default phased mode', false)
  .option('--filetrack', 'force filetrack on for this run')
  .option('--no-filetrack', 'force filetrack off for this run')
  .option('-c, --continue', 'continue the previous DeepSeek brain/coder tabs for this project and show past activity', false)
  .option(
    '--resume',
    'reattach to this project\'s existing planner/executor chat tabs instead of starting fresh',
    false
  )
  .option(
    '--close-session',
    'close this project\'s saved session tabs (if any) and forget it; no task needed',
    false
  )
  .option('--history [count]', 'print this project\'s past task runs (default: last 20) and exit; no task needed')
  .option(
    '--rewind [count]',
    'undo the last N filesystem-mutating tool calls (WRITE_FILE/EDIT_FILE/DELETE_FILE) for this project (default: 1) and exit; no task needed'
  )
  .option(
    '--json',
    'print each event as a single-line JSON object to stdout instead of the formatted ' +
      'terminal UI — for CI/scripting against a stable, machine-readable event feed ' +
      '(the same CLI_MESSAGE_TYPES payloads documented in readme.md section 3)',
    false
  )
  .option('--config <path>', 'override config directory (default .myclaudecode/ in project root)')
  .option('--verbose', 'print detailed debug info', false)
  .option(
    '--dashboard',
    'open a live, auto-updating process log in your browser (planner/executor turns, tool ' +
      'calls, timing) alongside the DeepSeek tabs, for watching a run in real time',
    false
  )
  .parse(process.argv);

const opts = program.opts();
const task = program.args[0];

// --json is a headless/CI mode: every ui.* call is presentational only (nothing in this
// file ever branches on a ui.* return value), so swapping every method to a no-op here is
// sufficient to silence the pretty terminal rendering everywhere it's called, without
// touching any of the actual state-machine logic (approvals, task completion, history) that
// those calls are interleaved with throughout the rest of this file.
if (opts.json) {
  for (const key of Object.keys(ui)) {
    if (typeof ui[key] === 'function') ui[key] = () => {};
  }
}

// No task typed on the command line is fine as long as there's a real terminal to prompt
// for one afterward (like Claude Code's own CLI: `claude` with no args drops you into its
// REPL instead of erroring). A non-interactive invocation (piped/scripted — e.g. this
// project's own e2e test harnesses) has no way to receive a task later, so it still needs
// one up front.
const isTTY = !!process.stdin.isTTY;
if (!opts.closeSession && !opts.history && !opts.rewind && !task && !isTTY) {
  console.error(
    'Error: a task is required when not running in an interactive terminal (unless --close-session, --history, or --rewind is passed).'
  );
  process.exit(1);
}

async function main() {
  const projectRoot = process.cwd();
  const configDir = opts.config ? path.resolve(opts.config) : path.join(projectRoot, '.myclaudecode');
  const { config, permissions } = ensureProjectConfig(configDir);
  if (opts.phased && opts.legacy) {
    console.error('Error: --phased and --legacy are mutually exclusive.');
    process.exit(1);
  }
  // Phase 9 (2026-10-25): phased is now the automatic default. `myclaudecode "task"`
  // runs phased mode with no flags needed -- the brain triages DIRECT vs PHASED, the
  // coder produces one a.py per unit of work, and every project-file change goes
  // through `python a.py` rather than one-file-at-a-time !WRITE_FILE/!EDIT_FILE tool
  // calls. Legacy mode stays reachable via --legacy (fallback for debugging and for
  // analysis-only tasks that don't fit the a.py model).
  //
  // config.phased.enabled is kept in the config file for backward compat, but no longer
  // affects mode selection -- only --legacy does. Existing configs with
  // phased.enabled: false will simply be ignored (harmless; the user can flip or
  // delete the field).
  const phasedEnabled = !opts.legacy;
  const filetrackOverride = opts.filetrack === true ? true : opts.filetrack === false ? false : null;
  const logger = makeLogger(configDir);

  if (opts.history) {
    // Read-only query — doesn't need the extension/native-host/WebSocket machinery (or the
    // banner, which is for the "about to start doing agent things" paths below) at all.
    const limit = typeof opts.history === 'string' && Number.isInteger(Number(opts.history)) ? Number(opts.history) : 20;
    ui.historyList(readHistory(configDir), limit);
    return;
  }

  if (opts.rewind) {
    // Pure local filesystem operation (see native-host/lib/tools.js's checkpoint/rewind
    // pair) — like --history, this needs none of the extension/native-host/WebSocket
    // machinery, since it's the CLI process itself restoring files it (via the native host,
    // in an earlier run) already snapshotted to .myclaudecode/checkpoints.
    const tools = require('../native-host/lib/tools');
    const count = typeof opts.rewind === 'string' && Number.isInteger(Number(opts.rewind)) ? Number(opts.rewind) : 1;
    const result = tools.rewind(projectRoot, count);
    if (result.reverted > 0) {
      ui.success(`Reverted ${result.reverted} change(s):`);
      for (const line of result.message.split('\n')) ui.info(line);
    } else {
      ui.info(result.message);
    }
    return;
  }

  // The REPL-style "stay alive, take the next task" behavior, and the pinned input box that
  // goes with it, only make sense attached to a real terminal on BOTH ends — stdin needs to
  // be a TTY for readline's line-editing/keypress events, and stdout needs to be a TTY for
  // the alternate-screen box to actually render anywhere. Computed once, up front, so every
  // later check (screen.enter(), the box setup, the readline wiring) agrees on the same
  // answer instead of screen.js and this REPL logic each deciding independently and
  // potentially disagreeing (e.g. stdin a real terminal but stdout redirected to a file would
  // otherwise leave the alt-screen/box active with no input box ever drawn into it). Piped/
  // scripted/CI usage (e.g. this project's own e2e test harnesses, which spawn the CLI with
  // stdio: ['ignore', ...]) gets readline's 'close' event almost immediately since there's no
  // real input stream; treating that as "user typed exit" would kill the process before the
  // task even finishes, so non-interactive runs fall back to the old one-shot
  // exit-after-completion behavior instead.
  const interactive = !opts.json && !!process.stdin.isTTY && !!process.stdout.isTTY;

  if (interactive) {
    screen.enter();
  }
  // Belt-and-braces: however the process ends (normal exit, Ctrl+C, uncaught error), the
  // alternate screen must be torn down so the user's real shell/scrollback reappears intact
  // — never leave them stuck looking at our frozen box layout after we're gone. Harmless
  // no-op if screen.enter() was never called above.
  process.on('exit', () => screen.exit());
  process.on('SIGINT', () => cleanupAndExit(0));
  process.on('SIGTERM', () => cleanupAndExit(0));

  ui.banner();
  if (opts.continue) ui.continueRecap(readHistory(configDir));

  if (opts.verbose) {
    ui.debug(`Project root: ${projectRoot}`);
    ui.debug(`Config dir: ${configDir}`);
    ui.debug(`Config: ${JSON.stringify(config)}`);
    ui.debug(`Permissions: ${JSON.stringify(permissions)}`);
  }

  logger.info(null, `Log file: ${logPath(configDir)}`);

  // Opened before the extension even connects, deliberately: the dashboard is a spectator
  // on the same event stream --json prints, and the user asked to watch it come up
  // side-by-side with the DeepSeek tabs, not after the fact.
  let dashboard = null;
  if (opts.dashboard) {
    const { startDashboard } = require('./lib/dashboard/server');
    dashboard = await startDashboard();
    ui.info(`Live process dashboard: ${dashboard.url}`);
    logger.info(null, `Dashboard listening at ${dashboard.url}`);
  }

  const { port, wss, waitForConnection } = await startServer();
  ui.info(`Local WebSocket server listening on 127.0.0.1:${port}`);
  ui.info('Waiting for extension to connect...');
  logger.info(null, `WebSocket server listening on 127.0.0.1:${port}, waiting for extension`);

  const ws = await waitForConnection();
  ui.info('Extension connected.');
  logger.info(null, 'Extension connected');

  let currentTaskId = uuidv4();

  // Pasting multi-line text (a whole file, a stack trace, several paragraphs) needs to land
  // in the box as literal newlines the user can keep editing — NOT get submitted turn-by-turn
  // the instant each embedded \n arrives, which is what plain readline does by default (it
  // treats every \r/\n as "Enter was pressed", paste or not). Real terminals solve exactly
  // this with "bracketed paste mode": once enabled (`\x1b[?2004h`, sent in screen.enter()),
  // a paste arrives wrapped in `ESC[200~...ESC[201~` markers instead of looking identical to
  // fast typing, so an app CAN tell the difference. This filter stream sits between the real
  // stdin and readline: it strips those markers out, buffers everything between them, and
  // inserts the whole thing into rl.line/rl.cursor directly (bypassing readline's normal
  // per-character handling — and its "each \n submits" behavior — entirely) instead of ever
  // forwarding the raw paste bytes to readline. Terminals/setups that never actually
  // negotiate bracketed paste (no `ESC[200~`) still get a fallback: a single 'data' chunk
  // containing more than one line ending, or one not at the very end, essentially can't be
  // real keystrokes (a human can't type that fast) and is treated as a paste too.
  const PASTE_START = '\x1b[200~';
  const PASTE_END = '\x1b[201~';
  const stdinFilter = new PassThrough();
  let pasteBuffer = null; // string accumulator while inside a bracketed paste; null when not

  function looksLikeMultilinePaste(s) {
    const firstNl = s.search(/[\n\r]/);
    if (firstNl === -1) return false;
    // A single trailing \n or \r\n (a normal Enter keypress) is not a paste.
    const rest = s.slice(firstNl).replace(/\r\n|\r|\n/g, '\n');
    return rest !== '\n' || firstNl !== s.length - rest.length;
  }

  function insertPastedText(text) {
    if (!interactive) return;
    // Pasted newlines become literal newlines in the buffer, not submissions — readline
    // itself has no concept of a multi-line buffer, so this only affects what's stored/shown;
    // Enter still submits the whole thing (with its embedded newlines) as one line's worth of
    // text once the user actually presses it.
    const before = rl.line.slice(0, rl.cursor);
    const after = rl.line.slice(rl.cursor);
    rl.line = before + text + after;
    rl.cursor = before.length + text.length;
    screen.drawInputBox(rl.line, rl.cursor);
  }

  if (interactive) {
    // readline's own raw-mode handling only ever applies to whatever stream it was HANDED —
    // since that's about to be the filter, not the real device, raw mode has to be requested
    // on the real stdin ourselves so keystrokes/pastes arrive unbuffered, one byte at a time,
    // instead of the terminal's own line-buffered "cooked" mode.
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (chunk) => {
      let s = chunk.toString('utf8');
      while (s.length) {
        if (pasteBuffer === null) {
          const startIdx = s.indexOf(PASTE_START);
          if (startIdx === -1) {
            if (looksLikeMultilinePaste(s)) {
              insertPastedText(s.replace(/\r\n|\r|\n/g, '\n'));
            } else {
              stdinFilter.write(s);
            }
            s = '';
          } else {
            stdinFilter.write(s.slice(0, startIdx));
            s = s.slice(startIdx + PASTE_START.length);
            pasteBuffer = '';
          }
        } else {
          const endIdx = s.indexOf(PASTE_END);
          if (endIdx === -1) {
            pasteBuffer += s;
            s = '';
          } else {
            pasteBuffer += s.slice(0, endIdx);
            s = s.slice(endIdx + PASTE_END.length);
            insertPastedText(pasteBuffer.replace(/\r\n|\r|\n/g, '\n'));
            pasteBuffer = null;
          }
        }
      }
    });
  }

  // readline still drives line-editing (history, arrow keys, ctrl+a/e/w, etc.), but its own
  // rendering is discarded (see screen.createSilentOutput) — the pinned input box at the
  // bottom of the screen (cli/lib/screen.js) is what the user actually sees, redrawn by hand
  // from rl.line/rl.cursor below. This is what lets task output stream into the scrolling
  // region above without ever colliding with whatever the user is mid-way through typing —
  // the box simply isn't part of that region. Reads from the paste-filtered stream above
  // (interactive) rather than raw stdin directly, so embedded newlines from a paste never
  // reach it as if Enter had been pressed.
  const rl = readline.createInterface({
    input: interactive ? stdinFilter : process.stdin,
    output: interactive ? screen.createSilentOutput() : process.stdout,
    terminal: interactive,
  });

  // Live-toggleable, like Claude Code's own shift+tab permission-mode cycle — seeded from
  // --approve-all but not fixed for the whole session. This is the ONLY place that decision
  // actually gets made: options.approveAll sent in run_task is stored on the orchestrator's
  // session (extension/lib/orchestrator.js) but never actually read there — every real
  // auto-approve-or-ask decision happens right here, in the TOOL_APPROVAL_REQUIRED handler
  // below, at the moment each request arrives. So flipping this mid-task takes effect
  // immediately for the next approval request, exactly like Claude Code's own toggle.
  let approveAll = !!opts.approveAll;

  if (interactive) {
    screen.setInputLabel('❯ ');
    screen.drawInputBox('', 0);
    // Fires on the filter stream now, not raw stdin directly — readline's emitKeypressEvents
    // attaches to whatever stream it was actually given as `input` (stdinFilter, see above),
    // so that's where decoded keypress events show up.
    stdinFilter.on('keypress', (_str, key) => {
      // ctrl+o: reprint whatever the last "… +N lines" collapse cut off, in full — see
      // ui.expandLast. Node's readline doesn't bind ctrl+o to anything itself, unlike
      // ctrl+r/ctrl+s (reverse-i-search), so this is safe to claim.
      if (key && key.ctrl && key.name === 'o') {
        ui.expandLast();
        return;
      }
      // shift+tab: cycle manual-approval <-> auto-approve-all, live, without restarting —
      // arrives as the CSI "back-tab" sequence (`key.name === 'tab', key.shift === true`),
      // not bound to anything else by readline. Works in any mode (idle or busy), same as
      // Claude Code — you can flip it while a task is mid-flight and the next approval
      // prompt honors the new setting.
      if (key && key.shift && key.name === 'tab') {
        approveAll = !approveAll;
        ui.statusLine(approveAll);
        return;
      }
      // Arrow-key navigation for a question's options — the closest a real terminal gets to
      // "clickable": up/down moves a live highlight (rendered in the box's status area, see
      // renderOptionSelector below) and Enter with nothing typed confirms whatever's
      // currently highlighted (see the 'awaiting-answer' branch in rl.on('line') above).
      // Typing a number or free text still works exactly as before and takes precedence.
      if (mode === 'awaiting-answer' && pendingAnswerOptions.length && key && (key.name === 'up' || key.name === 'down')) {
        const n = pendingAnswerOptions.length;
        selectedOptionIndex = key.name === 'up' ? (selectedOptionIndex - 1 + n) % n : (selectedOptionIndex + 1) % n;
        renderOptionSelector();
        return;
      }
      screen.drawInputBox(rl.line, rl.cursor);
    });
  }

  // Like Claude Code's own CLI: the process doesn't exit after one task. 'idle' means
  // ready for the user to type the next task; 'busy' means one is in flight (anything
  // typed then is queued, not lost, and sent automatically once the current task ends);
  // 'awaiting-approval' means the next line is a y/N answer, not a new task. Starts 'idle'
  // when no task was given on the command line (nothing in flight to be 'busy' with yet).
  let mode = task ? 'busy' : 'idle';
  let pendingApprovalResolve = null;
  let pendingAnswerResolve = null;
  let pendingAnswerOptions = [];
  // Which option the arrow-key selector is currently highlighting (see the keypress
  // handler's up/down branch and renderOptionSelector below) — reset to the first option
  // every time a fresh question with options arrives.
  let selectedOptionIndex = 0;
  const taskQueue = [];
  // Running per-task checklist of dispatched subtasks (see ui.todoList) — reset whenever a
  // fresh task is sent so it doesn't bleed into the next one in this REPL session.
  let todoList = [];

  function send(type, payload) {
    ws.send(JSON.stringify({ type, taskId: currentTaskId, ...payload }));
  }

  function askApproval(message) {
    return new Promise((resolve) => {
      pendingApprovalResolve = resolve;
      mode = 'awaiting-approval';
      if (interactive) ui.inputRule();
      screen.print(`${message} [y/N] `);
    });
  }

  // Live-redrawn into the box's transient status area (same mechanism the "thinking" spinner
  // uses — see ui.startThinking) rather than reprinted into scrollback on every arrow press,
  // which would otherwise spam the conversation history with one line per keystroke. The
  // question text and full option list are still printed once, permanently, by ui.question
  // below; this is only the live "here's what Enter will pick right now" indicator.
  function renderOptionSelector() {
    if (!interactive || !pendingAnswerOptions.length) return;
    const n = pendingAnswerOptions.length;
    screen.status(ui.optionSelector(pendingAnswerOptions, selectedOptionIndex, n));
  }

  // Same idea as Claude Code's AskUserQuestion: the planner/executor can pause mid-task
  // and ask a real question instead of guessing. With options, answer with the arrow keys +
  // Enter (or by number, or type a custom answer anyway — like an implicit "Other"); with no
  // options, whatever's typed is the answer verbatim.
  function askUserQuestion(question, options) {
    return new Promise((resolve) => {
      pendingAnswerResolve = resolve;
      pendingAnswerOptions = options || [];
      selectedOptionIndex = 0;
      mode = 'awaiting-answer';
      if (interactive) ui.inputRule();
      ui.question(question, pendingAnswerOptions);
      renderOptionSelector();
    });
  }

  let currentTaskText = null;
  let currentTaskStartedAt = null;

  // Real bug caught live (2026-08-15), same day the "default to continuing tabs" change
  // below was made: a plain `resume = true` default applied to EVERY sendTask call
  // regardless of context, including the very FIRST task of a brand-new project typed
  // interactively (no task on the command line, so it goes through the idle-mode call site
  // below rather than the argv one) — that path has no prior task in this process to
  // continue at all, so it always tried to resume, printing a confusing "(system) --resume
  // requested..." notice the user never asked for on what was, from their side, a totally
  // fresh run. This flag is the actual signal that matters: "has THIS process sent any task
  // yet," not "was a task argument given on argv" — sendTask itself falls back to it below
  // whenever a call site doesn't specify `resume` explicitly.
  let hasSentAnyTaskInThisProcess = !!opts.continue;

  // The very first task in this process only reattaches when explicitly asked via --resume
  // (see the argv call site below, which always specifies `resume` itself and so never hits
  // this fallback). Every OTHER send here — a follow-up typed in the REPL, or a queued task
  // — defaults to continuing the same tabs/conversation once at least one task has already
  // gone out in this process. This flipped per live feedback (2026-08-15): the previous
  // default (always fresh tabs) meant every follow-up re-paid the planner/executor priming
  // cost and lost all prior exploration (file structure already discovered, files already
  // read) — the executor would re-run the same !LS/!SHELL discovery it had already done
  // moments earlier, purely because the tab was thrown away. DeepSeek's own per-chat length
  // budget (session.charBudget, tens of thousands of characters) comfortably covers several
  // related follow-ups before migration would even be a concern, so continuity is the
  // better default for the common case — an unrelated follow-up can still ask for a fresh
  // start explicitly (this function's `resume` param, or a future CLI flag) rather than the
  // common case silently paying for the rare one.
  function sendTask(taskText, { resume } = {}) {
    const effectiveResume = resume !== undefined ? resume : hasSentAnyTaskInThisProcess;
    hasSentAnyTaskInThisProcess = true;
    if (interactive) ui.inputRule();
    mode = 'busy';
    currentTaskId = uuidv4();
    currentTaskText = taskText;
    currentTaskStartedAt = new Date().toISOString();
    todoList = [];
    send(CLI_MESSAGE_TYPES.RUN_TASK, {
      task: taskText,
      options: {
        approveAll,
        webSearch: !opts.disableWebSearch,
        deepThink: opts.deepThink,
        resume: effectiveResume,
        // orchestrator.js runs in the browser extension, with no OS access of its own —
        // the CLI (real Node process) is the only place `process.platform` is available at
        // all, so it has to ride along here to reach the primer. Added per live feedback
        // (2026-08-15): a whole night of real tasks kept re-discovering "this is Windows"
        // the hard way — wrong-slash paths (C:\... vs /c/... vs /mnt/c/...), `net start`
        // vs `systemctl`, guessing at which one would work before finding the one that did.
        // Telling it up front once is strictly cheaper than that trial and error every time.
        os: process.platform,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
        phased: phasedEnabled,
        filetrack: filetrackOverride,
      },
      config,
      permissions,
      projectRoot,
    });
    ui.info(`Task sent (taskId=${currentTaskId}): ${taskText}`);
  }

  // Continues the REPL after a task ends: send whatever's queued next, or drop to idle
  // and wait for the user to type something. Non-interactive runs just exit, matching the
  // old one-shot behavior.
  function advance(exitCodeIfNonInteractive) {
    if (!interactive) {
      cleanupAndExit(exitCodeIfNonInteractive);
      return;
    }
    if (taskQueue.length) {
      sendTask(taskQueue.shift());
      return;
    }
    mode = 'idle';
    // The pinned input box (cli/lib/screen.js) is already sitting there redrawn after every
    // ui.* call — nothing extra needed here to bring the prompt back.
    ui.info('Ready — type your next task, or "exit" to quit.');
    ui.inputRule();
    ui.statusLine(approveAll);
  }

  if (interactive) {
    rl.on('line', (line) => {
      const input = line.trim();
      // Clear the box to empty FIRST, then echo what was submitted into scrollback — doing
      // it in the other order (echo, then clear) has print() redraw the box once still
      // showing the just-submitted text (this.lastText hadn't been reset yet) before the
      // very next call redraws it empty, a visible flash/flicker of stale text for no reason.
      // Clearing first means every redraw from here on only ever shows the box actually
      // empty.
      screen.drawInputBox('', 0);
      ui.userLine(input);

      if (mode === 'awaiting-approval') {
        const resolve = pendingApprovalResolve;
        pendingApprovalResolve = null;
        mode = 'busy';
        ui.inputRule();
        resolve(/^y(es)?$/i.test(input));
        return;
      }

      if (mode === 'awaiting-answer') {
        const resolve = pendingAnswerResolve;
        const options = pendingAnswerOptions;
        pendingAnswerResolve = null;
        pendingAnswerOptions = [];
        mode = 'busy';
        ui.inputRule();
        screen.status('');
        // Nothing typed but an arrow-selected option is live (see the keypress handler's
        // up/down branch below) — Enter confirms whatever's currently highlighted, the
        // terminal equivalent of "clicking" it. Typing something (a number, or free text)
        // always takes precedence, same as before.
        const asNumber = Number(input);
        const answer = !input && options.length
          ? options[selectedOptionIndex]
          : Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length
            ? options[asNumber - 1]
            : input;
        resolve(answer);
        return;
      }

      if (mode === 'busy') {
        if (!input) return;
        taskQueue.push(input);
        ui.info(`Queued (will run after the current task finishes): ${input}`);
        return;
      }

      // mode === 'idle'
      if (!input) {
        rl.prompt();
        return;
      }
      if (/^(exit|quit)$/i.test(input)) {
        cleanupAndExit(0);
        return;
      }
      // Continues the existing tabs/conversation by default now (see sendTask's own
      // comment) — this is a genuine follow-up, not the very first task of a cold start.
      sendTask(input);
    });

    rl.on('close', () => cleanupAndExit(0));
    // The box was already drawn empty right after the readline interface was created above
    // — you can type ahead into it (it'll queue) while the first task is still running too.
  } else {
    // Non-interactive: approval/question prompts have nowhere to go, so answer them the
    // same way rl.question() used to (read whatever's on stdin once, e.g. a scripted line).
    rl.on('line', (line) => {
      if (mode === 'awaiting-approval' && pendingApprovalResolve) {
        const resolve = pendingApprovalResolve;
        pendingApprovalResolve = null;
        resolve(/^y(es)?$/i.test(line.trim()));
        return;
      }
      if (mode === 'awaiting-answer' && pendingAnswerResolve) {
        const resolve = pendingAnswerResolve;
        const options = pendingAnswerOptions;
        pendingAnswerResolve = null;
        pendingAnswerOptions = [];
        const input = line.trim();
        const asNumber = Number(input);
        const answer =
          Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length
            ? options[asNumber - 1]
            : input;
        resolve(answer);
      }
    });
  }

  // Turns every protocol message into one persistent log line — the file-based record of
  // "what was each agent doing and when" the user asked for, independent of --verbose (which
  // only controls terminal echo and is lost once the scrollback/session ends). Long text
  // fields are truncated; the full untruncated payload is still available via --verbose if
  // needed live, this is for after-the-fact/tail -f monitoring.
  const LOG_TEXT_MAX = 500;
  const trunc = (s) => {
    const str = String(s == null ? '' : s);
    return str.length > LOG_TEXT_MAX ? `${str.slice(0, LOG_TEXT_MAX)}… (${str.length} chars)` : str;
  };
  function logEvent(msg) {
    switch (msg.type) {
      case CLI_MESSAGE_TYPES.THINKING_STARTED:
        logger.info(msg.role, 'thinking started');
        break;
      case CLI_MESSAGE_TYPES.PLANNER_THINKING:
        logger.info('planner', trunc(msg.text));
        break;
      case CLI_MESSAGE_TYPES.EXECUTOR_CODE:
        logger.info('executor', trunc(msg.summary || msg.diff || msg.content));
        break;
      case CLI_MESSAGE_TYPES.SUBTASK_STARTED:
        logger.info('planner', `subtask started: ${trunc(msg.subtask)}`);
        break;
      case CLI_MESSAGE_TYPES.SUBTASK_FINISHED:
        logger.info('executor', 'subtask finished');
        break;
      case CLI_MESSAGE_TYPES.TOOL_CALL:
        logger.info(msg.role, `tool call: ${msg.tool}`, { params: msg.params });
        break;
      case CLI_MESSAGE_TYPES.TOOL_CALL_RESULT:
        if (msg.error) {
          logger.error(msg.role, `tool failed: ${msg.tool}: ${trunc(msg.error)}`, { params: msg.params });
        } else {
          logger.info(msg.role, `tool result: ${msg.tool}`, { result: trunc(JSON.stringify(msg.result)) });
        }
        break;
      case CLI_MESSAGE_TYPES.TOOL_APPROVAL_REQUIRED:
        logger.info(msg.role, `approval requested: ${msg.description || msg.tool || ''}`);
        break;
      case CLI_MESSAGE_TYPES.USER_QUESTION_REQUIRED:
        logger.info(msg.role, `question asked: ${trunc(msg.question)}`);
        break;
      case CLI_MESSAGE_TYPES.QUALITY_GATE_FAILED:
        logger.warning(msg.role, `quality gate failed: ${msg.gate}`, { output: trunc(msg.output) });
        break;
      case CLI_MESSAGE_TYPES.TASK_COMPLETED:
        logger.info(null, `task completed: ${trunc(msg.summary)}`, { stats: msg.stats });
        break;
      case CLI_MESSAGE_TYPES.TASK_ERROR:
        logger.error(null, `task error: ${trunc(msg.message)}`, { stats: msg.stats });
        break;
      case CLI_MESSAGE_TYPES.SESSION_CLOSED:
        logger.info(null, msg.closed ? 'session closed' : (msg.reason || 'nothing to close'));
        break;
      // Timing/diagnostics from content.js's waitForAssistantSettle (see shared/protocol.js's
      // TIMING comment) — the concrete "what was DeepSeek doing and for how long" data the
      // user asked for, now persisted instead of only visible live under --verbose.
      case CLI_MESSAGE_TYPES.TIMING: {
        // promptPreview/replyPreview (tab_reply phase) are what make this line answer "what
        // did we send DeepSeek, what did it send back, and how long did that take" in one
        // place. tab_setup/gather_context/executor_primer (this session's addition) cover
        // the initial-setup phase that used to be a silent gap before the planner's first
        // turn. send_attempt (also new) reports one line per retry attempt inside
        // sendToTabResilient, so a multi-retry stall shows its individual attempts instead of
        // one opaque final failure — attempt/attempts/error identify which retry and why.
        const attemptSuffix =
          msg.phase === 'send_attempt' ? ` (attempt ${msg.attempt}/${msg.attempts}${msg.error ? `, error: ${msg.error}` : ''})` : '';
        logger.info(msg.role, `timing: ${msg.phase} took ${msg.elapsedMs}ms${attemptSuffix}`, {
          diagnostics: msg.diagnostics,
          promptChars: msg.promptChars,
          promptPreview: msg.promptPreview,
          replyChars: msg.replyChars,
          replyPreview: msg.replyPreview,
          error: msg.phase === 'send_attempt' ? undefined : msg.error, // send_attempt's error is already in attemptSuffix
        });
        break;
      }
      case CLI_MESSAGE_TYPES.TRIAGE_DECIDED:
        logger.info(msg.role || 'planner', `triaged: mode=${msg.mode || '?'} estLoc=${msg.estimate ?? '?'}`);
        break;
      case CLI_MESSAGE_TYPES.DIRECT_MODE_ESCALATED:
        logger.warning('planner', `direct mode escalated: ${trunc(msg.reason || '')}`);
        break;
      case CLI_MESSAGE_TYPES.PHASE_STARTED:
        logger.info('executor', `phase started: ${msg.phase || '?'} (${msg.index ?? '?'}/${msg.total ?? '?'})`);
        break;
      case CLI_MESSAGE_TYPES.PHASE_SUCCESS:
        logger.info('executor', `phase success: ${msg.phase || '?'} (${msg.durationMs ?? '?'}ms)`);
        break;
      case CLI_MESSAGE_TYPES.PHASE_FAILED:
        logger.error('executor', `phase failed: ${msg.phase || '?'} after ${msg.attempts ?? '?'} attempt(s): ${trunc(msg.traceback || '')}`);
        break;
      case CLI_MESSAGE_TYPES.ATTENTION_PING:
        logger.warning('planner', `attention: ${trunc(JSON.stringify(msg.item || {}))}`);
        break;
      case CLI_MESSAGE_TYPES.MIGRATED:
      case CLI_MESSAGE_TYPES.BRAIN_MIGRATED:
        logger.info(msg.role, `migrated ${msg.role || '?'} (${msg.reason || '?'}, ${msg.mode || '?'} bundle, ${msg.bundleChars ?? '?'} chars)`);
        break;
      case CLI_MESSAGE_TYPES.BUNDLE_TOO_LARGE:
        logger.warning(null, `bundle too large: ${msg.chars ?? '?'} chars (threshold ${msg.threshold ?? '?'})`);
        break;
      case CLI_MESSAGE_TYPES.EXCLUSION_ROUND_STARTED:
        logger.info(null, 'exclusion round started');
        break;
      case CLI_MESSAGE_TYPES.EXCLUSION_ROUND_DONE:
        logger.info(null, `exclusion round ${msg.round ?? '?'} done: ${msg.chars ?? '?'} chars${msg.stillTooLarge ? ' (still too large)' : ''}`);
        break;
      case CLI_MESSAGE_TYPES.RATE_LIMIT_DETECTED:
        logger.warning(msg.role || null, 'rate limit detected');
        break;
      default:
        break;
    }
  }

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      ui.error(`Received malformed message: ${err.message}`);
      return;
    }
    // Defense-in-depth against a stale prior task's messages arriving here — see
    // CANCEL_TASK's protocol.js comment. A force-killed previous CLI process (Stop-Process
    // -Force, SIGKILL) can't run cleanupAndExit's best-effort CANCEL_TASK send, so the
    // orchestrator may still deliver an old, abandoned task's result into this new, unrelated
    // process once that old tab finally replies. Discarding anything whose taskId doesn't
    // match the task this process actually started is what stops that from corrupting
    // `mode`/`pendingAnswerResolve` here — observed live (2026-08-14): an orphaned ASK_USER
    // from a killed run wedged a brand-new run's stdin wait this exact way.
    if (msg.taskId && msg.taskId !== currentTaskId) {
      logger.warning(null, `Ignoring stale message from an abandoned task: ${msg.type}`, { staleTaskId: msg.taskId });
      if (opts.verbose) ui.debug(`Ignoring stale message from a different task: ${msg.type} (taskId=${msg.taskId})`);
      return;
    }
    if (opts.verbose) ui.debug(`<- ${JSON.stringify(msg)}`);
    logEvent(msg);
    // The one line of real output --json mode cares about — every event, verbatim, one per
    // line, straight to stdout. Approval/question prompts still need answering below (via
    // --approve-all or piped stdin, same as any other non-interactive run); this only
    // replaces the human-facing rendering, not the underlying protocol handling.
    if (opts.json) console.log(JSON.stringify(msg));
    if (dashboard) dashboard.push(msg);
    if (msg.type !== CLI_MESSAGE_TYPES.THINKING_STARTED) ui.stopThinking();

    switch (msg.type) {
      case CLI_MESSAGE_TYPES.THINKING_STARTED:
        ui.startThinking(msg.role);
        break;

      case CLI_MESSAGE_TYPES.PLANNER_THINKING:
        ui.reasoning('planner', msg.text || '');
        break;

      case CLI_MESSAGE_TYPES.EXECUTOR_CODE:
        ui.reasoning('executor', msg.summary || msg.diff || msg.content || '');
        break;

      case CLI_MESSAGE_TYPES.SUBTASK_STARTED:
        ui.subtaskStarted(msg.subtask || '');
        todoList.push({ text: msg.subtask || '', status: 'in_progress' });
        ui.todoList(todoList);
        break;

      case CLI_MESSAGE_TYPES.SUBTASK_FINISHED: {
        const current = [...todoList].reverse().find((t) => t.status === 'in_progress');
        if (current) current.status = 'done';
        ui.todoList(todoList);
        break;
      }

      case CLI_MESSAGE_TYPES.TOOL_CALL:
        ui.toolCall(msg.role, msg.tool, msg.params);
        break;

      case CLI_MESSAGE_TYPES.TOOL_CALL_RESULT:
        ui.toolResult(msg.role, msg.tool, msg.params, msg.result, msg.error, {
          oldContent: msg.oldContent,
          newContent: msg.newContent,
        });
        break;

      case CLI_MESSAGE_TYPES.TOOL_APPROVAL_REQUIRED: {
        const description = msg.description || `${msg.tool || ''} ${msg.command || ''}`.trim();
        let approved;
        if (approveAll) {
          approved = true;
          ui.warn(`Auto-approving (shift+tab mode): ${description}`);
        } else {
          ui.approvalPrompt(description, { matchedWord: msg.matchedWord, cwd: msg.cwd });
          approved = await askApproval('Proceed?');
        }
        send(CLI_MESSAGE_TYPES.APPROVE_TOOL, { approvalId: msg.approvalId, approved });
        break;
      }

      case CLI_MESSAGE_TYPES.USER_QUESTION_REQUIRED: {
        const answer = await askUserQuestion(msg.question || '', msg.options || []);
        send(CLI_MESSAGE_TYPES.ANSWER_USER_QUESTION, { questionId: msg.questionId, answer });
        break;
      }

      case CLI_MESSAGE_TYPES.QUALITY_GATE_FAILED:
        ui.gate(msg.gate, msg.output);
        break;

      case CLI_MESSAGE_TYPES.TASK_COMPLETED:
        todoList.filter((t) => t.status === 'in_progress').forEach((t) => (t.status = 'done'));
        ui.taskCompleted(msg.summary);
        ui.stats(msg.stats);
        appendHistoryEntry(configDir, {
          taskId: currentTaskId,
          task: currentTaskText,
          status: 'completed',
          summary: msg.summary || null,
          startedAt: currentTaskStartedAt,
          endedAt: new Date().toISOString(),
        });
        advance(0);
        break;

      case CLI_MESSAGE_TYPES.TASK_ERROR:
        todoList.filter((t) => t.status === 'in_progress').forEach((t) => (t.status = 'failed'));
        ui.error(msg.message || 'Unrecoverable error.');
        ui.stats(msg.stats);
        appendHistoryEntry(configDir, {
          taskId: currentTaskId,
          task: currentTaskText,
          status: 'failed',
          message: msg.message || null,
          startedAt: currentTaskStartedAt,
          endedAt: new Date().toISOString(),
        });
        // A single failed task shouldn't kill the whole REPL session — same reasoning as
        // Claude Code: let the user try again or move on, rather than losing the live
        // planner/executor tabs and having to reconnect from scratch. Non-interactive runs
        // still exit non-zero, same as before.
        advance(1);
        break;

      case CLI_MESSAGE_TYPES.SESSION_CLOSED:
        // Passed through to cleanupAndExit rather than printed here: this ends the process
        // right after, and anything printed into the alternate screen buffer is discarded
        // the instant we switch back out of it on exit — so the final message has to be
        // printed AFTER that switch, not before.
        cleanupAndExit(0, msg.closed ? 'Session closed and forgotten.' : msg.reason || 'Nothing to close.');
        break;

      case CLI_MESSAGE_TYPES.TRIAGE_DECIDED:
        ui.info(`Triaged: mode=${msg.mode || '?'}, est. ${msg.estimate ?? '?'} LOC`);
        break;

      case CLI_MESSAGE_TYPES.DIRECT_MODE_ESCALATED:
        ui.escalated(msg.reason || 'direct mode failed', msg.filesTouched || []);
        break;

      case CLI_MESSAGE_TYPES.PHASE_STARTED:
        ui.phaseStarted(msg.phase || '?', msg.index ?? 0, msg.total ?? 0);
        break;

      case CLI_MESSAGE_TYPES.PHASE_SUCCESS:
        ui.phaseSuccess(msg.phase || '?', msg.durationMs ?? 0, msg.filesTouched || []);
        break;

      case CLI_MESSAGE_TYPES.PHASE_FAILED:
        ui.phaseFailed(msg.phase || '?', msg.attempts ?? 0, msg.traceback || '');
        break;

      case CLI_MESSAGE_TYPES.ATTENTION_PING:
        ui.attentionItem(msg.item || {});
        break;

      case CLI_MESSAGE_TYPES.MIGRATED:
      case CLI_MESSAGE_TYPES.BRAIN_MIGRATED:
        ui.migrated(msg.role || '?', msg.reason || '?', msg.mode || '?', msg.bundleChars ?? 0);
        break;

      case CLI_MESSAGE_TYPES.BUNDLE_TOO_LARGE:
        ui.bundleTooLarge(msg.chars ?? 0, msg.threshold ?? 0);
        break;

      case CLI_MESSAGE_TYPES.EXCLUSION_ROUND_STARTED:
        ui.exclusionRoundStarted();
        break;

      case CLI_MESSAGE_TYPES.EXCLUSION_ROUND_DONE:
        ui.exclusionRoundDone(msg.round ?? 0, msg.chars ?? 0, !!msg.stillTooLarge);
        break;

      case CLI_MESSAGE_TYPES.RATE_LIMIT_DETECTED:
        if (msg.retryAt) ui.rateLimitCountdown(msg.role, msg.retryAt, msg.attempt, msg.maxRetries);
        else ui.warn('Rate limit detected — backing off before migration.');
        break;

      default:
        if (opts.verbose) ui.debug(`Unhandled message type: ${msg.type}`);
    }
  });

  ws.on('close', () => {
    cleanupAndExit(1, 'Extension/native-host connection closed.');
  });

  let exiting = false;
  // finalMessage (if given) is printed to the plain, restored screen — never through ui.*,
  // since anything in the alternate screen buffer vanishes the instant screen.exit() below
  // switches back out of it.
  function cleanupAndExit(code, finalMessage) {
    if (exiting) return;
    exiting = true;
    ui.stopThinking();
    // Best-effort — see CANCEL_TASK's protocol.js comment. Only covers a graceful exit path
    // (this function running at all); a force-kill (Stop-Process -Force, SIGKILL) skips this
    // entirely, which is exactly why cli/index.js's own incoming-message taskId filter below
    // exists as a second, unconditional layer of defense against a stale prior task's replies.
    try {
      if (ws.readyState === 1) send(CLI_MESSAGE_TYPES.CANCEL_TASK, {});
    } catch (_) {
      // best-effort only — never let this block actual shutdown
    }
    screen.exit();
    if (finalMessage) console.log(finalMessage);
    rl.close();
    cleanupPortFile();
    wss.close();
    if (dashboard) dashboard.close();
    process.exit(code);
  }

  if (opts.closeSession) {
    send(CLI_MESSAGE_TYPES.CLOSE_SESSION, { projectRoot });
    ui.info(`Requested session close for ${projectRoot}`);
    return;
  }

  if (task) {
    sendTask(task, { resume: !!(opts.resume || opts.continue) });
  } else {
    // Preparation (server start, extension connect) already happened above — this is the
    // "ready and waiting" state, same as after any task completes. The box itself was
    // already drawn empty right after the readline interface was set up above.
    ui.info('Ready — type your task, or "exit" to quit.');
    ui.inputRule();
    ui.statusLine(approveAll);
  }
}

main().catch((err) => {
  // Restore the real screen BEFORE printing — anything written into the alternate screen
  // buffer is discarded the moment we switch back out of it, so a fatal error logged first
  // would flash and vanish instead of actually reaching the user.
  screen.exit();
  console.error(err.stack || err.message);
  cleanupPortFile();
  process.exit(1);
});
