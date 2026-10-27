const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const SHELL_TIMEOUT_MS = 30000;
const MAX_BUFFER = 10 * 1024 * 1024;

// Models are trained overwhelmingly on Unix shells — `ls`, `grep`, `cat`, `rm -rf` are
// what they reach for. Plain cmd.exe doesn't understand any of that, so on Windows we
// prefer Git Bash (near-universal alongside Git itself, and what this very tool's own
// Bash environment runs on) and only fall back to cmd.exe if it's genuinely not present.
// Detected once and cached — it can't change mid-process.
let cachedWindowsBashPath; // undefined = not yet checked, null = checked and not found

function findWindowsBashPath() {
  if (cachedWindowsBashPath !== undefined) return cachedWindowsBashPath;

  const candidates = [];
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'));
  if (process.env['ProgramFiles(x86)']) {
    candidates.push(path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'));
  }
  candidates.push('C:\\Program Files\\Git\\bin\\bash.exe');

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      cachedWindowsBashPath = candidate;
      return cachedWindowsBashPath;
    }
  }

  try {
    const output = execFileSync('where', ['bash'], { encoding: 'utf8' });
    const first = output.split(/\r?\n/).find((line) => line.trim());
    if (first && fs.existsSync(first.trim())) {
      cachedWindowsBashPath = first.trim();
      return cachedWindowsBashPath;
    }
  } catch (_) {
    // `where bash` found nothing or isn't available — fall through to cmd.exe
  }

  cachedWindowsBashPath = null;
  return cachedWindowsBashPath;
}

// Same shell-selection logic as runShell() below, but for a persistent (no -c, reads
// commands from stdin) session instead of a one-shot spawn. Used by persistentShell.js.
function resolvePersistentShell() {
  const isWin = process.platform === 'win32';
  const windowsBash = isWin ? findWindowsBashPath() : null;
  if (windowsBash) return { shellPath: windowsBash, args: ['--noprofile', '--norc'], isCmd: false };
  if (isWin) return { shellPath: 'cmd.exe', args: ['/q'], isCmd: true };
  return { shellPath: '/bin/sh', args: [], isCmd: false };
}

// Backs TOOLS.ENV_INFO (see shared/protocol.js) — orchestrator.js runs in the browser
// extension with no OS/child_process access of its own, so this is the one authoritative
// place that actually knows what resolvePersistentShell() picked for THIS machine, rather
// than the primer having to guess "bash is probably available" from process.platform alone.
function envInfo() {
  const { isCmd } = resolvePersistentShell();
  return {
    platform: process.platform,
    shell: isCmd ? 'cmd.exe' : 'bash',
  };
}

class PathSafetyError extends Error {}

function resolveInProject(projectRoot, relPath, { allowOutside = false } = {}) {
  const resolved = path.resolve(projectRoot, relPath || '.');
  const root = path.resolve(projectRoot);
  const isInside = resolved === root || resolved.startsWith(root + path.sep);
  if (!isInside && !allowOutside) {
    throw new PathSafetyError(`Path "${relPath}" resolves outside the project root and is not allowed.`);
  }
  return resolved;
}

// Large files (a generated bundle, a big log, a huge data file) used to have to cross the
// chat channel in one piece — expensive in both turn latency and the message-count budget
// that triggers migration (readme.md section 9). Backward-compatible by construction: a
// file at or under this line count, read with no explicit offset/limit, returns exactly the
// same plain string it always did — nothing downstream (memory.md re-injection, conventions
// loading, the WRITE_FILE/EDIT_FILE diff display's oldContent) ever sees a wrapper header
// unless it actually asked for a page or the file is genuinely huge.
const READ_FILE_DEFAULT_MAX_LINES = 2000;

// Phase 25 (2026-10-25): readFile now honors an `allowOutside` flag. When
// true, the path can resolve outside the project root. Used by the phased-mode
// brain during triage inspection (see PhasedRunner.runBrainToolCalls) -- a user
// asking "what about that other project at C:\\...?" needs the brain to be able
// to read it. Default (no flag) preserves the original behavior: everything is
// hard-scoped to the project. The brain caller injects allowOutside=true; the
// legacy orchestrator never does, so legacy stays byte-identical in scope.
//
// Safety cap: when allowOutside is true, files > 500,000 chars are truncated
// with a marker -- protects the caller from accidentally reading a huge system
// file (e.g. a 5MB log) into the brain prompt.
const MAX_ALLOW_OUTSIDE_CHARS = 500_000;
function readFile(projectRoot, { path: relPath, offset, limit, allowOutside = false }) {
  const target = resolveInProject(projectRoot, relPath, { allowOutside });
  if (!fs.existsSync(target)) throw new Error(`File not found: ${relPath}`);
  let content = fs.readFileSync(target, 'utf8');
  if (allowOutside && content.length > MAX_ALLOW_OUTSIDE_CHARS) {
    content = content.slice(0, MAX_ALLOW_OUTSIDE_CHARS) +
      `\n…(truncated at ${MAX_ALLOW_OUTSIDE_CHARS} of ${content.length} chars -- ` +
      `use !READ_FILE <path> <offset> <limit> for a specific range)`;
  }

  const hasExplicitRange = offset != null || limit != null;
  const lines = content.split('\n');
  const total = lines.length;

  if (!hasExplicitRange) {
    if (total <= READ_FILE_DEFAULT_MAX_LINES) return content;
    // Large file, no page requested — auto-paginate rather than silently dumping the whole
    // thing into the chat. PARTIAL is a fixed, greppable marker (see toolCalls.js parsing)
    // telling the model exactly how to fetch the rest.
    const shown = lines.slice(0, READ_FILE_DEFAULT_MAX_LINES).join('\n');
    return `${shown}\n\n(PARTIAL — showing lines 1-${READ_FILE_DEFAULT_MAX_LINES} of ${total}. Use !READ_FILE ${relPath} ${READ_FILE_DEFAULT_MAX_LINES + 1} to continue.)`;
  }

  const start = Math.max(1, Number(offset) || 1);
  const count = Number(limit) > 0 ? Number(limit) : READ_FILE_DEFAULT_MAX_LINES;
  const startIdx = start - 1;
  const endIdx = Math.min(total, startIdx + count);
  const slice = lines.slice(startIdx, endIdx).join('\n');
  const header = `(lines ${start}-${endIdx} of ${total})`;
  return endIdx < total
    ? `${header}\n${slice}\n\n(PARTIAL — use !READ_FILE ${relPath} ${endIdx + 1} to continue.)`
    : `${header}\n${slice}`;
}

// --- Pre-mutation checkpointing (backs `--rewind`) --------------------------------------
// Snapshots a file's content immediately before WRITE_FILE/EDIT_FILE/DELETE_FILE touches it,
// so a later `--rewind` can restore it. Deliberately scoped to files only (a directory
// DELETE_FILE is not snapshotted — recursively snapshotting a whole tree is unbounded work
// for a local dev tool, and this is the same scoping tradeoff Claude Code's own checkpointing
// makes for bash-modified files) and to these three tools only — SHELL's side effects are not
// tracked, since a shell command can touch anything, unbounded, with no fixed `path` param to
// snapshot against.
const CHECKPOINT_DIR = '.myclaudecode/checkpoints';

function checkpointManifestPath(projectRoot) {
  return path.join(projectRoot, CHECKPOINT_DIR, 'manifest.jsonl');
}

function loadCheckpointEntries(projectRoot) {
  const p = checkpointManifestPath(projectRoot);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null; // tolerate a corrupted/partial trailing line
      }
    })
    .filter(Boolean);
}

// Best-effort by design: called from inside writeFile/editFile/deletePath, right before the
// real mutation. A checkpointing failure (disk full, permissions) must never block the actual
// tool call it's shadowing — callers wrap this in try/catch and swallow errors.
function recordCheckpoint(projectRoot, tool, relPath) {
  const target = resolveInProject(projectRoot, relPath, { allowOutside: true });
  const existed = fs.existsSync(target) && fs.statSync(target).isFile();
  let snapshotFile = null;
  if (existed) {
    const snapshotDir = path.join(projectRoot, CHECKPOINT_DIR, 'snapshots');
    fs.mkdirSync(snapshotDir, { recursive: true });
    snapshotFile = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.snap`;
    fs.copyFileSync(target, path.join(snapshotDir, snapshotFile));
  }
  const entry = { tool, path: relPath, existed, snapshotFile, timestamp: Date.now() };
  fs.mkdirSync(path.dirname(checkpointManifestPath(projectRoot)), { recursive: true });
  fs.appendFileSync(checkpointManifestPath(projectRoot), `${JSON.stringify(entry)}\n`, 'utf8');
}

function checkpointBestEffort(projectRoot, tool, relPath) {
  try {
    recordCheckpoint(projectRoot, tool, relPath);
  } catch (_) {
    // never let checkpointing failure block the real mutation
  }
}

// Restores the last `count` checkpointed mutations for this project, most-recent-first,
// across any past task (checkpoints aren't scoped per-taskId — "undo what the agent just
// did" is a project-level operation, same mental model as a normal undo stack). A file that
// didn't exist before its mutation is removed (undoing a creation); a file that did exist is
// restored from its pre-mutation snapshot. Reverted entries are trimmed off the manifest so
// repeated `--rewind` calls keep stepping further back.
function rewind(projectRoot, count = 1) {
  const entries = loadCheckpointEntries(projectRoot);
  if (!entries.length) return { reverted: 0, message: 'No checkpoints recorded for this project yet.' };

  const n = Math.max(1, Math.min(count, entries.length));
  const toRevert = entries.slice(-n).reverse();
  const messages = [];

  for (const entry of toRevert) {
    const target = resolveInProject(projectRoot, entry.path, { allowOutside: true });
    if (entry.existed && entry.snapshotFile) {
      const snapshotPath = path.join(projectRoot, CHECKPOINT_DIR, 'snapshots', entry.snapshotFile);
      if (fs.existsSync(snapshotPath)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(snapshotPath, target);
        messages.push(`Restored ${entry.path} to its state before ${entry.tool}.`);
      } else {
        messages.push(`(skipped) Snapshot for ${entry.path} (before ${entry.tool}) is missing — could not restore.`);
      }
    } else {
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      messages.push(`Removed ${entry.path} (did not exist before ${entry.tool}).`);
    }
  }

  const remaining = entries.slice(0, entries.length - toRevert.length);
  const body = remaining.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(checkpointManifestPath(projectRoot), remaining.length ? `${body}\n` : '', 'utf8');

  return { reverted: toRevert.length, message: messages.join('\n') };
}
// -----------------------------------------------------------------------------------------

function writeFile(projectRoot, { path: relPath, content }, permissions) {
  const target = resolveInProject(projectRoot, relPath, {
    allowOutside: !!(permissions && permissions.fileWriteOutsideProject),
  });
  checkpointBestEffort(projectRoot, 'WRITE_FILE', relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content == null ? '' : String(content), 'utf8');
  return `Wrote ${Buffer.byteLength(String(content || ''), 'utf8')} bytes to ${relPath}`;
}

// Anchored replacement, the same idea as Claude Code's Edit tool: `oldString` must appear in
// the file EXACTLY ONCE (not zero, not more) — zero means the model's anchor text doesn't
// match reality (stale read, typo), more than one means the edit is ambiguous about which
// occurrence was meant. Both are reported back as a specific, actionable error rather than
// silently guessing, so the model can retry with more surrounding context. Existing since the
// alternative (WRITE_FILE, a whole-file rewrite) is what this tool exists to avoid for
// anything but a brand-new or fully-rewritten file.
function editFile(projectRoot, { path: relPath, oldString, newString }) {
  const target = resolveInProject(projectRoot, relPath);
  if (!fs.existsSync(target)) throw new Error(`File not found: ${relPath} (use WRITE_FILE to create a new file).`);
  const content = fs.readFileSync(target, 'utf8');
  const old = oldString == null ? '' : String(oldString);
  if (!old) throw new Error('EDIT_FILE requires a non-empty oldString to anchor the replacement.');

  const firstIdx = content.indexOf(old);
  if (firstIdx === -1) {
    throw new Error(`oldString was not found in ${relPath} — no changes made. Re-read the file and match its exact current content.`);
  }
  const lastIdx = content.lastIndexOf(old);
  if (firstIdx !== lastIdx) {
    let count = 0;
    let searchFrom = 0;
    while (true) {
      const idx = content.indexOf(old, searchFrom);
      if (idx === -1) break;
      count++;
      searchFrom = idx + old.length;
    }
    throw new Error(`oldString was found ${count} times in ${relPath} — it must be unique. Include more surrounding context to disambiguate which occurrence to replace.`);
  }

  checkpointBestEffort(projectRoot, 'EDIT_FILE', relPath);
  const updated = content.slice(0, firstIdx) + (newString == null ? '' : String(newString)) + content.slice(firstIdx + old.length);
  fs.writeFileSync(target, updated, 'utf8');
  return `Edited ${relPath} (replaced 1 occurrence).`;
}

// Deliberately does NOT accept a permissions.fileWriteOutsideProject-style override the way
// writeFile does — deletion is irreversible, so unlike a write (which can at worst clobber
// something you can rewrite), there is no config escape hatch to ever delete outside the
// project root. resolveInProject's allowOutside stays hard-false, always.
function deletePath(projectRoot, { path: relPath }) {
  const trimmed = (relPath || '').trim();
  if (!trimmed || trimmed === '.' || trimmed === '/' || trimmed === '\\') {
    throw new Error('Refusing to delete the project root itself — pass a specific file or subfolder path.');
  }
  const target = resolveInProject(projectRoot, trimmed);
  const root = path.resolve(projectRoot);
  if (target === root) {
    throw new Error('Refusing to delete the project root itself — pass a specific file or subfolder path.');
  }
  if (!fs.existsSync(target)) {
    return `Nothing to delete: "${relPath}" does not exist.`;
  }
  const isDir = fs.statSync(target).isDirectory();
  if (isDir) {
    fs.rmSync(target, { recursive: true, force: true });
    return `Deleted directory: ${relPath} (not revertible via --rewind: directories aren't checkpointed).`;
  }
  checkpointBestEffort(projectRoot, 'DELETE_FILE', trimmed);
  fs.rmSync(target, { recursive: true, force: true });
  return `Deleted file: ${relPath}`;
}

// Returns the specific dangerousCommands entry that matched (for showing the user exactly
// why an approval prompt fired), or null if nothing matched.
function matchDangerous(command, dangerousCommands) {
  const words = command.split(/\s+/).filter(Boolean);
  const direct = words.find((w) => dangerousCommands.includes(w));
  if (direct) return direct;
  return (
    dangerousCommands.find((d) =>
      new RegExp(`(^|[\\s;&|])${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s;&|]|$)`).test(command)
    ) || null
  );
}

function isDangerous(command, dangerousCommands) {
  return matchDangerous(command, dangerousCommands) != null;
}

// --- Pattern-based permission rules (permissions.json's optional `rules` field) ---------
// The original `dangerousCommands` word list can only express "these specific words always
// need approval" — it can't express "always allow npm test" and "always ask before git
// push" as two separate, specific rules. `rules: {allow, ask, deny}` (arrays of
// "TOOL(pattern)" strings, e.g. "SHELL(npm test)", "WRITE_FILE(*.env)") replaces it with
// real precedence: deny beats ask beats allow, first match wins within each bucket.
// Deliberately opt-in: everything below only activates when a project's permissions.json
// actually sets `rules` — omitting it keeps 100% of the original per-tool behavior (see
// evaluatePermission's fallback branch).

// Splits a compound shell command into its constituent subcommands on &&, ||, ;, |, and
// newlines, so each part is checked independently — an allow rule for "npm test" must not
// silently extend across "&& rm -rf /" riding along in the same command string.
function splitCompoundCommand(command) {
  return String(command || '')
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Simple glob: `*` matches any run of characters, everything else is literal. Deliberately
// not a full shell-glob implementation (no `?`, `[...]`, brace expansion) — enough to write
// "npm run *" or "*.env" without needing regex knowledge, which is the actual goal.
function globMatch(pattern, value) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

// Parses a "TOOL(pattern)" rule string. Returns null for anything that doesn't match that
// shape (a malformed rule is silently skipped rather than crashing the whole evaluation —
// consistent with this being local config a human hand-edits and can typo).
function parseRule(rule) {
  const m = /^([A-Z_]+)\((.*)\)$/.exec(String(rule || '').trim());
  return m ? { tool: m[1], pattern: m[2] } : null;
}

function evaluateRuleSet(rules, tool, value) {
  for (const bucket of ['deny', 'ask', 'allow']) {
    const list = (rules && rules[bucket]) || [];
    for (const raw of list) {
      const parsed = parseRule(raw);
      if (parsed && parsed.tool === tool && globMatch(parsed.pattern, value)) {
        return { verdict: bucket, pattern: parsed.pattern };
      }
    }
  }
  return null;
}

// Single entry point host.js calls for every gate-able tool. Returns { verdict, matched }
// where verdict is 'deny' | 'ask' | 'allow' and matched is a human-readable description of
// what triggered it (or null if nothing did — implicit allow).
function evaluatePermission(permissions, tool, value) {
  if (permissions && permissions.rules) {
    if (tool === 'SHELL' || tool === 'SHELL_BG') {
      // A denied subcommand anywhere in the chain denies the whole thing; the strictest
      // verdict found across all subcommands wins otherwise (ask beats an unmatched allow).
      let verdict = 'allow';
      let matched = null;
      for (const sub of splitCompoundCommand(value)) {
        const r = evaluateRuleSet(permissions.rules, 'SHELL', sub);
        if (r && r.verdict === 'deny') return { verdict: 'deny', matched: `SHELL(${r.pattern}) matched "${sub}"` };
        if (r && r.verdict === 'ask' && verdict !== 'ask') {
          verdict = 'ask';
          matched = `SHELL(${r.pattern}) matched "${sub}"`;
        } else if (r && r.verdict === 'allow' && matched === null) {
          // Doesn't change `verdict` (an ask found later in the chain still wins) — just
          // makes sure an explicit allow match is reported as such rather than looking
          // identical to "nothing matched at all".
          matched = `SHELL(${r.pattern}) matched "${sub}"`;
        }
      }
      return { verdict, matched };
    }
    const r = evaluateRuleSet(permissions.rules, tool, value);
    return r ? { verdict: r.verdict, matched: `${tool}(${r.pattern})` } : { verdict: 'allow', matched: null };
  }

  // Legacy fallback (no `rules` configured) — SHELL/SHELL_BG only; every other tool keeps
  // its own original hardcoded behavior at its call site in host.js untouched.
  if (tool === 'SHELL' || tool === 'SHELL_BG') {
    const dangerousCommands = (permissions && permissions.dangerousCommands) || [];
    const word = matchDangerous(value, dangerousCommands);
    return word ? { verdict: 'ask', matched: word } : { verdict: 'allow', matched: null };
  }
  return { verdict: 'allow', matched: null };
}
// -----------------------------------------------------------------------------------------

function runShell(projectRoot, { command }) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const windowsBash = isWin ? findWindowsBashPath() : null;
    const child = windowsBash
      ? spawn(windowsBash, ['-c', command], { cwd: projectRoot, windowsHide: true })
      : isWin
        ? spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd: projectRoot, windowsHide: true })
        : spawn('/bin/sh', ['-c', command], { cwd: projectRoot });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ stdout, stderr, exitCode: null, timedOut: true });
    }, SHELL_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > MAX_BUFFER) stdout = stdout.slice(-MAX_BUFFER);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > MAX_BUFFER) stderr = stderr.slice(-MAX_BUFFER);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut: false });
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + '\n' + err.message, exitCode: 1, timedOut: false });
    });
  });
}

// --- Lifecycle hooks (config.json's `hooks` field) ---------------------------------------
// User-configured infrastructure, not model-controlled — never gated behind approval, and
// never reachable from chat text (see TOOLS.RUN_HOOK's comment). A hook receives the event
// name and a JSON payload via a temp file (env var-safe regardless of payload size/content,
// unlike cramming JSON directly into an env var), and communicates back purely through its
// process exit code: exit 2 is the one code with special meaning (`preToolUse` blocks the
// tool and feeds the hook's stderr back to the model as the reason); every other exit code
// is informational only — a failing postToolUse/onGateResult/onTaskComplete hook doesn't
// alter orchestration, it's surfaced as a warning to the CLI and nothing more.
function runHook(projectRoot, { command, event, payload }) {
  return new Promise((resolve) => {
    const trimmed = String(command || '').trim();
    if (!trimmed) {
      resolve({ exitCode: 0, stdout: '', stderr: '', blocked: false, timedOut: false });
      return;
    }

    let payloadFile = null;
    try {
      const dir = path.join(projectRoot, '.myclaudecode', 'hook-payloads');
      fs.mkdirSync(dir, { recursive: true });
      payloadFile = path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
      fs.writeFileSync(payloadFile, JSON.stringify(payload || {}, null, 2), 'utf8');
    } catch (_) {
      payloadFile = null; // best-effort — a hook that needs the payload just won't get one
    }

    const isWin = process.platform === 'win32';
    const windowsBash = isWin ? findWindowsBashPath() : null;
    const env = { ...process.env, MCC_HOOK_EVENT: event, MCC_HOOK_PAYLOAD_FILE: payloadFile || '' };
    const child = windowsBash
      ? spawn(windowsBash, ['-c', trimmed], { cwd: projectRoot, windowsHide: true, env })
      : isWin
        ? spawn('cmd.exe', ['/d', '/s', '/c', trimmed], { cwd: projectRoot, windowsHide: true, env })
        : spawn('/bin/sh', ['-c', trimmed], { cwd: projectRoot, env });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (payloadFile) {
        try {
          fs.unlinkSync(payloadFile);
        } catch (_) {
          // best-effort cleanup
        }
      }
      resolve({ ...result, blocked: result.exitCode === 2 });
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ stdout, stderr, exitCode: null, timedOut: true });
    }, SHELL_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => finish({ stdout, stderr, exitCode: code, timedOut: false }));
    child.on('error', (err) => finish({ stdout, stderr: `${stderr}\n${err.message}`, exitCode: 1, timedOut: false }));
  });
}
// -----------------------------------------------------------------------------------------

// --- Background processes (SHELL_BG / PROC_LIST / PROC_LOG / PROC_KILL) -----------------
// Unlike OPEN_APP (which on Windows launches through `cmd.exe /c start`, a wrapper that hands
// off and exits almost immediately — see openApp's own comments — so the pid it observes is
// never the real long-running target), this spawns the shell directly, the same way runShell
// does, just without waiting for exit. That means the pid Node sees here IS the real process,
// so listing/reading/killing it afterward is actually reliable.
// taskId -> Map(procId -> record)
const backgroundProcs = new Map();
const BG_LOG_MAX = 200000; // chars, generous but bounded — this can run far longer than a normal SHELL call

function capBgLog(buf) {
  return buf.length > BG_LOG_MAX ? buf.slice(-BG_LOG_MAX) : buf;
}

function runBackgroundShell(projectRoot, taskId, { command }) {
  const trimmed = String(command || '').trim();
  if (!trimmed) throw new Error('SHELL_BG requires a command.');

  const isWin = process.platform === 'win32';
  const windowsBash = isWin ? findWindowsBashPath() : null;
  const child = windowsBash
    ? spawn(windowsBash, ['-c', trimmed], { cwd: projectRoot, windowsHide: true })
    : isWin
      ? spawn('cmd.exe', ['/d', '/s', '/c', trimmed], { cwd: projectRoot, windowsHide: true })
      : spawn('/bin/sh', ['-c', trimmed], { cwd: projectRoot });

  const id = crypto.randomBytes(4).toString('hex');
  const record = { child, command: trimmed, startedAt: Date.now(), buffer: '', exitCode: null };
  child.stdout.on('data', (d) => {
    record.buffer = capBgLog(record.buffer + d.toString());
  });
  child.stderr.on('data', (d) => {
    record.buffer = capBgLog(record.buffer + d.toString());
  });
  child.on('exit', (code) => {
    record.exitCode = code;
  });
  child.on('error', (err) => {
    record.buffer = capBgLog(`${record.buffer}\n[spawn error] ${err.message}`);
    record.exitCode = -1;
  });

  if (!backgroundProcs.has(taskId)) backgroundProcs.set(taskId, new Map());
  backgroundProcs.get(taskId).set(id, record);
  return { id, command: trimmed, message: `Started in background as process ${id}. Use !PROC_LOG ${id} to check its output, !PROC_KILL ${id} to stop it.` };
}

function procList(taskId) {
  const map = backgroundProcs.get(taskId);
  if (!map || !map.size) return 'No background processes for this task.';
  return Array.from(map.entries())
    .map(([id, r]) => `${id}  ${r.exitCode === null ? 'running' : `exited(${r.exitCode})`}  ${r.command}`)
    .join('\n');
}

function procLog(taskId, { id, lines }) {
  const map = backgroundProcs.get(taskId);
  const record = map && map.get(id);
  if (!record) throw new Error(`No background process with id "${id}" for this task. Use !PROC_LIST to see active ones.`);
  const n = Number(lines) > 0 ? Number(lines) : 100;
  const allLines = record.buffer.split('\n');
  const tail = allLines.slice(-n).join('\n');
  const status = record.exitCode === null ? 'still running' : `exited with code ${record.exitCode}`;
  return `[${record.command}] (${status})\n${tail || '(no output yet)'}`;
}

function procKill(taskId, { id }) {
  const map = backgroundProcs.get(taskId);
  const record = map && map.get(id);
  if (!record) throw new Error(`No background process with id "${id}" for this task. Use !PROC_LIST to see active ones.`);
  if (record.exitCode !== null) return `Process ${id} already exited with code ${record.exitCode}.`;
  try {
    record.child.kill();
  } catch (_) {
    // best-effort — the process may have exited in the race between the check above and this call
  }
  return `Kill signal sent to process ${id}.`;
}

// Called when a task's native-host connection tears down (see host.js) — a background
// process has no other owner once its task is gone, so it would otherwise leak indefinitely.
function killAllBackgroundProcs(taskId) {
  const map = backgroundProcs.get(taskId);
  if (!map) return;
  for (const record of map.values()) {
    if (record.exitCode === null) {
      try {
        record.child.kill();
      } catch (_) {
        // already gone
      }
    }
  }
  backgroundProcs.delete(taskId);
}

function killAllBackgroundProcsEverywhere() {
  for (const taskId of Array.from(backgroundProcs.keys())) killAllBackgroundProcs(taskId);
}
// -----------------------------------------------------------------------------------------

// Fixed, small set of recognized app shortcuts — launching one of these (or opening a bare
// URL/file with no app name) needs no approval, same tier as read-only tools, since the
// blast radius is small and predictable. Anything else falls through to "arbitrary detached
// command" (see buildLaunchInvocation below), which host.js gates behind approval exactly
// like a dangerous SHELL command — genuinely unbounded, just non-blocking.
// NOTE: verified on Windows only (this project is Windows-only tested throughout, per
// readme.md). macOS/Linux branches below are best-effort and unverified.
const CHROME_ALIASES = ['chrome', 'google-chrome', 'chrome.exe', 'googlechrome'];
const CMD_ALIASES = ['cmd', 'cmd.exe', 'commandprompt', 'terminal'];
const CODE_ALIASES = ['code', 'vscode', 'code.exe', 'vs', 'visualstudiocode'];
const EXPLORER_ALIASES = ['explorer', 'explorer.exe', 'fileexplorer'];
const KNOWN_APP_ALIASES = new Set([...CHROME_ALIASES, ...CMD_ALIASES, ...CODE_ALIASES, ...EXPLORER_ALIASES]);

function splitFirstWord(command) {
  const trimmed = command.trim();
  const spaceIdx = trimmed.indexOf(' ');
  return spaceIdx === -1
    ? { first: trimmed, rest: '' }
    : { first: trimmed.slice(0, spaceIdx), rest: trimmed.slice(spaceIdx + 1).trim() };
}

// True for the fixed alias set, or a bare URL/file-with-extension with no extra args (the
// "open this specific thing with its default handler" case) — false for anything else
// (arbitrary commands, e.g. "npm run dev"), which host.js treats as needing approval.
function isKnownAppCommand(command) {
  const { first, rest } = splitFirstWord(String(command || ''));
  const key = first.toLowerCase();
  if (KNOWN_APP_ALIASES.has(key)) return true;
  if (!rest && (/^https?:\/\//i.test(first) || /\.[a-z0-9]{1,8}$/i.test(first))) return true;
  return false;
}

function buildLaunchInvocation(command) {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const { first, rest } = splitFirstWord(command);
  const key = first.toLowerCase();

  if (isWin) {
    // `start "" <app> <args>` — the empty "" is the window-title arg `start` expects first;
    // without it, `start` misreads the app name itself as the title. Fire-and-forget: cmd.exe
    // hands off to the target app and exits almost immediately on its own.
    if (CHROME_ALIASES.includes(key)) return { cmd: 'cmd.exe', args: ['/c', 'start', '', 'chrome', ...(rest ? [rest] : [])] };
    if (CMD_ALIASES.includes(key)) return { cmd: 'cmd.exe', args: ['/c', 'start', '', 'cmd', ...(rest ? ['/k', rest] : [])] };
    if (CODE_ALIASES.includes(key)) return { cmd: 'cmd.exe', args: ['/c', 'code', rest || '.'] };
    if (EXPLORER_ALIASES.includes(key)) return { cmd: 'cmd.exe', args: ['/c', 'start', '', 'explorer', rest || '.'] };
    if (!rest && (/^https?:\/\//i.test(first) || /\.[a-z0-9]{1,8}$/i.test(first))) {
      // No recognized app name — hand off to the OS default handler (default browser for a
      // URL/.html, whatever's associated with the file's extension otherwise).
      return { cmd: 'cmd.exe', args: ['/c', 'start', '', command] };
    }
    // Arbitrary command (e.g. "npm run dev") — open a visible cmd window running it,
    // detached, so a long-running dev server doesn't block on SHELL's 30s timeout.
    return { cmd: 'cmd.exe', args: ['/c', 'start', '', 'cmd', '/k', command] };
  }

  if (isMac) {
    if (CHROME_ALIASES.includes(key)) return { cmd: 'open', args: ['-a', 'Google Chrome', ...(rest ? [rest] : [])] };
    if (CODE_ALIASES.includes(key)) return { cmd: 'code', args: [rest || '.'] };
    if (CMD_ALIASES.includes(key)) return { cmd: 'open', args: ['-a', 'Terminal'] };
    if (!rest) return { cmd: 'open', args: [first] };
    return { cmd: 'open', args: [command] };
  }

  // Linux best-effort.
  if (CHROME_ALIASES.includes(key)) return { cmd: 'google-chrome', args: rest ? [rest] : [] };
  if (CODE_ALIASES.includes(key)) return { cmd: 'code', args: [rest || '.'] };
  if (!rest) return { cmd: 'xdg-open', args: [first] };
  return { cmd: 'xdg-open', args: [command] };
}

// Launches `command` detached and non-blocking (never waits for the app/process to exit —
// GUI apps and dev servers don't, and SHELL's 30s timeout exists precisely because normal
// commands should). Resolves quickly once the launch itself has either visibly failed (e.g.
// app not found) or had a brief window to succeed.
function openApp(projectRoot, { command }) {
  const trimmed = String(command || '').trim();
  if (!trimmed) {
    return Promise.reject(new Error('OPEN_APP requires a command, e.g. "chrome http://localhost:3000" or "code ."'));
  }
  const { cmd, args } = buildLaunchInvocation(trimmed);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: projectRoot, detached: true, stdio: 'ignore', windowsHide: false });
    let settled = false;

    // Give the spawn a brief window to fail fast (e.g. the app genuinely isn't installed)
    // before assuming success — most launchers (cmd.exe /c start, etc.) exit near-instantly
    // on their own once they've handed off to the real app, so this rarely actually waits
    // the full window.
    const grace = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve(`Launched: ${trimmed}`);
    }, 800);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      reject(new Error(`Failed to launch "${trimmed}": ${err.message}`));
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      child.unref();
      resolve(
        code === 0 || code === null
          ? `Launched: ${trimmed}`
          : `"${trimmed}" exited immediately with code ${code} (it may not have started correctly).`
      );
    });
  });
}

// Phase 25 (2026-10-25): grep honors allowOutside, with a filesystem-root
// guard -- refuses to grep a drive root or / because that would recurse the
// entire filesystem. Brain should point at a specific subdirectory.
function grep(projectRoot, { pattern, path: subPath, allowOutside = false }) {
  const dir = resolveInProject(projectRoot, subPath || '.', { allowOutside });
  if (allowOutside) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Refusing to grep the filesystem root (${dir}). Point at a specific subdirectory.`
      );
    }
  }
  return new Promise((resolve) => {
    const tryTool = (cmd, args, onMissing) => {
      const child = spawn(cmd, args, { cwd: projectRoot });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', () => onMissing());
      child.on('close', (code) => {
        if (code === 127) return onMissing();
        resolve(stdout || (code === 1 ? '(no matches)' : stderr));
      });
    };
    tryTool('rg', ['-n', '--', pattern, dir], () => {
      tryTool('grep', ['-rn', '--', pattern, dir], () => {
        resolve('Neither ripgrep (rg) nor grep is available on this system.');
      });
    });
  });
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withGlobs = escaped.replace(/\*\*|\*/g, (m) => (m === '**' ? '.*' : '[^/\\\\]*'));
  return new RegExp(`^${withGlobs}$`, 'i');
}

function findFile(projectRoot, { glob }) {
  const root = resolveInProject(projectRoot, '.');
  const matcher = globToRegExp(glob);
  const results = [];
  const IGNORE = new Set(['node_modules', '.git', '.myclaudecode']);

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (matcher.test(entry.name)) {
        results.push(path.relative(root, full));
      }
    }
  }
  walk(root);
  return results.join('\n') || '(no matches)';
}

// Own, much shorter timeout than SHELL's 30s — this exists specifically for a quick "did
// the server actually come up" check (e.g. after `!OPEN_APP npm run dev`), not for
// fetching large or slow resources. Response body is capped independently of MAX_BUFFER
// (SHELL's much larger allowance) since a whole HTML page dumped into the model's context
// is rarely useful past the first few KB anyway.
const HTTP_GET_TIMEOUT_MS = 10000;
const HTTP_GET_MAX_BODY = 20000;

// GET-only, deliberately — this is a read/verify tool (like GREP or LS), not a general HTTP
// client, so there's no method/body/headers surface to worry about misusing.
async function httpGet(projectRoot, { url }) {
  const trimmed = String(url || '').trim();
  if (!trimmed) throw new Error('HTTP_GET requires a URL, e.g. "http://localhost:3000".');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`HTTP_GET requires an http(s):// URL, got: "${trimmed}"`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_GET_TIMEOUT_MS);
  try {
    const res = await fetch(trimmed, { signal: controller.signal, redirect: 'follow' });
    const bodyFull = await res.text();
    const body = bodyFull.length > HTTP_GET_MAX_BODY ? bodyFull.slice(0, HTTP_GET_MAX_BODY) : bodyFull;
    return {
      status: res.status,
      ok: res.ok,
      contentType: res.headers.get('content-type') || null,
      body,
      truncated: bodyFull.length > HTTP_GET_MAX_BODY,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`HTTP_GET timed out after ${HTTP_GET_TIMEOUT_MS / 1000}s: ${trimmed}`);
    }
    throw new Error(`HTTP_GET failed for ${trimmed}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Phase 25 (2026-10-25): ls honors allowOutside (brain triage inspection).
// Safety cap: when allowOutside is true, output is capped at 300 entries with a
// truncation marker -- protects against !LS C:\\ returning thousands of names.
const MAX_ALLOW_OUTSIDE_LS_ENTRIES = 300;
function ls(projectRoot, { path: subPath, allowOutside = false }) {
  // LS never supports shell-style flags (-la etc.) — a model occasionally sends them
  // anyway (e.g. "!LS -la some/path"), which would otherwise be treated as a literal,
  // bogus path component ("-la some/path") and fail with a confusing ENOENT. Strip any
  // leading whitespace-separated tokens that look like flags before resolving.
  let cleaned = (subPath || '.').trim();
  while (/^-\S+(\s|$)/.test(cleaned)) {
    cleaned = cleaned.replace(/^-\S+\s*/, '').trim();
  }
  const target = resolveInProject(projectRoot, cleaned || '.', { allowOutside });
  const entries = fs.readdirSync(target, { withFileTypes: true });
  const cap = allowOutside ? MAX_ALLOW_OUTSIDE_LS_ENTRIES : entries.length;
  const shown = entries.slice(0, cap);
  const lines = shown.map((e) => {
    let stat;
    try { stat = fs.statSync(path.join(target, e.name)); } catch (_) { stat = { size: 0 }; }
    const type = e.isDirectory() ? 'd' : '-';
    return `${type} ${String(stat.size).padStart(8)} ${e.name}`;
  });
  if (entries.length > cap) {
    lines.push(`…(${entries.length - cap} more entries omitted; !LS <specific-subdir> to narrow)`);
  }
  return lines.join('\n');
}

// Backs progress-based stall detection (orchestrator.js): a cheap fingerprint of the whole
// project tree, so the orchestrator can tell "the executor reported DONE again, but did
// anything actually change on disk?" apart from "3 differently-worded replies that all
// amount to the same no-op" — a real failure mode the existing message-shape-based stall
// counter can't see, since it only counts unproductive-*looking* turns, not unproductive
// ones. Uses size+mtime per file, not content hashing — content-hashing every file on every
// subtask would be far too slow for a check that runs this often; size+mtime collisions on a
// genuine edit are effectively impossible (a write always updates mtime).
function hashWorkingTree(projectRoot) {
  const root = resolveInProject(projectRoot, '.');
  const IGNORE = new Set(['node_modules', '.git', '.myclaudecode']);
  const entries = [];

  function walk(dir) {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const item of items) {
      if (IGNORE.has(item.name)) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        const stat = fs.statSync(full);
        entries.push(`${path.relative(root, full)}:${stat.size}:${stat.mtimeMs}`);
      } catch (_) {
        // file vanished between readdir and stat — skip it, not worth failing the whole hash
      }
    }
  }
  walk(root);
  entries.sort();
  return crypto.createHash('sha256').update(entries.join('\n')).digest('hex');
}

// --- Persistent structured task list (survives chat-limit migrations) -------------------
// Maintained automatically by the orchestrator from the [SUBTASK] dispatch/finish lifecycle
// it already tracks — not a model-facing tool (see TOOLS.TASK_UPSERT's comment) — so it
// stays accurate without depending on the model remembering an extra bookkeeping call every
// time. Project-scoped, like memory.md and the checkpoint manifest: it isn't cleared between
// separate top-level tasks in the same project, matching how those already behave.
const TASKS_FILE = '.myclaudecode/tasks.json';

function loadTaskList(projectRoot) {
  const p = path.join(projectRoot, TASKS_FILE);
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return []; // corrupted/partial file — start fresh rather than crashing the task
  }
}

function saveTaskList(projectRoot, tasks) {
  const p = path.join(projectRoot, TASKS_FILE);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
}

// Creates a new entry when `id` isn't given (or doesn't match an existing one), otherwise
// updates the matching entry's `text`/`status` in place. Returns the resulting entry either
// way, so the caller can capture a freshly-created id for its later update call.
function upsertTask(projectRoot, { id, text, status }) {
  const tasks = loadTaskList(projectRoot);
  const now = Date.now();
  const existing = id ? tasks.find((t) => t.id === id) : null;
  if (existing) {
    if (text != null) existing.text = text;
    if (status != null) existing.status = status;
    existing.updatedAt = now;
    saveTaskList(projectRoot, tasks);
    return existing;
  }
  const created = {
    id: id || crypto.randomBytes(4).toString('hex'),
    text: text || '',
    status: status || 'pending',
    createdAt: now,
    updatedAt: now,
  };
  tasks.push(created);
  saveTaskList(projectRoot, tasks);
  return created;
}

function listTasks(projectRoot) {
  return loadTaskList(projectRoot);
}
// -----------------------------------------------------------------------------------------

// --- Layered, path-scoped instructions (.myclaudecode/rules/*.md) -----------------------
// Deliberately much smaller than CLAUDE.md-style layering — one flat conventions file plus
// these path-scoped ones — because primer length here directly consumes the same
// message-count budget that triggers chat-limit migration (unlike an API-driven harness,
// where a big system prompt is comparatively cheap). A rule only costs anything once a
// matching file is actually touched, not on every turn.
function parseRuleFile(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const frontmatter = m[1];
  const body = m[2].trim();
  const pathsMatch = /paths:\s*(.+)/.exec(frontmatter);
  if (!pathsMatch || !body) return null;
  const rawPaths = pathsMatch[1].trim();
  let paths;
  if (rawPaths.startsWith('[')) {
    try {
      paths = JSON.parse(rawPaths);
    } catch (_) {
      paths = [];
    }
  } else {
    paths = rawPaths
      .split(',')
      .map((p) => p.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  return Array.isArray(paths) && paths.length ? { paths, body } : null;
}

function loadRuleFiles(projectRoot) {
  const dir = path.join(projectRoot, '.myclaudecode', 'rules');
  if (!fs.existsSync(dir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'));
  } catch (_) {
    return [];
  }
  const rules = [];
  for (const file of entries) {
    try {
      const parsed = parseRuleFile(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (parsed) rules.push({ file, ...parsed });
    } catch (_) {
      // skip unreadable/malformed rule file rather than failing the whole load
    }
  }
  return rules;
}
// -----------------------------------------------------------------------------------------

// --- Declarative external tools (.myclaudecode/tools.json) ------------------------------
// The closest thing this project has to MCP: a project declares {name, description, args,
// command} entries; the model calls them as !CALL_<NAME> arg1 arg2 (see toolCalls.js), and
// orchestrator.js substitutes the positional args into `command`'s {argName} placeholders
// and runs it through the exact same SHELL path (dangerous-command/permission-rule gating
// included) a plain !SHELL call would use — no separate trust tier, since these are still
// just shell commands, only pre-named and pre-described for convenience.
function loadExternalTools(projectRoot) {
  const p = path.join(projectRoot, '.myclaudecode', 'tools.json');
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t) => t && typeof t.name === 'string' && typeof t.command === 'string' && /^[A-Za-z0-9_]+$/.test(t.name)
    );
  } catch (_) {
    return [];
  }
}
// -----------------------------------------------------------------------------------------

// Backs TOOLS.FILETRACK_SCAN (see shared/protocol.js) — delegates to the dedicated
// filetrack module. Wrapped here rather than exposed directly so host.js's execTool switch
// stays a plain "case TOOLS.X: return tools.Y(params)" one-liner like every other tool.
// `mode` is 'check' (baseline-only on first run, otherwise read+log changes) or
// 'snapshot' (also force a snapshot write even with zero changes, used at task end).
function filetrackScan(projectRoot, params) {
  const filetrack = require('./filetrack');
  return filetrack.computeChanges(projectRoot, {
    mode: (params && params.mode) || 'check',
    bulkThreshold: (params && params.bulkThreshold) || 100,
  });
}

module.exports = {
  PathSafetyError,
  resolveInProject,
  readFile,
  writeFile,
  editFile,
  deletePath,
  rewind,
  isDangerous,
  matchDangerous,
  evaluatePermission,
  isKnownAppCommand,
  openApp,
  httpGet,
  runShell,
  runHook,
  runBackgroundShell,
  procList,
  procLog,
  procKill,
  killAllBackgroundProcs,
  killAllBackgroundProcsEverywhere,
  resolvePersistentShell,
  envInfo,
  grep,
  findFile,
  ls,
  hashWorkingTree,
  upsertTask,
  listTasks,
  loadRuleFiles,
  loadExternalTools,
  filetrackScan,
};
