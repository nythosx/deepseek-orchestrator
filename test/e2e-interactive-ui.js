#!/usr/bin/env node
// Exercises the CLI's actual *interactive* terminal UI (cli/index.js + cli/lib/screen.js +
// cli/lib/ui.js) end-to-end — something none of the other e2e-*.js tests touch, since they
// all spawn the CLI with piped (non-TTY) stdio and a task on the command line, which skips
// the whole alternate-screen/pinned-input-box/REPL code path entirely.
//
// Technique: runs cli/index.js IN-PROCESS (not spawned) after replacing process.stdin/
// process.stdout with fake PassThrough streams stamped `isTTY = true` — Node reads
// process.stdout/stdin dynamically everywhere in this codebase (verified: no module caches
// a reference at require-time except cli/index.js's own top-level `isTTY` check, which is
// why env/argv/stdio are all set up BEFORE requiring it), so this reliably fools every
// isTTY check into taking the real interactive path. Keystrokes are fed by writing raw bytes
// into the fake stdin (readline's keypress parser works off the byte stream regardless of
// real OS raw-mode, which only matters for an actual terminal device). The "extension" side
// is played directly over the CLI's own WebSocket protocol (see cli/lib/server.js — it
// treats the first connecting `ws` client as the extension, no native-host/handshake needed)
// with a small scripted run_task response, deliberately including a long tool result to
// exercise truncation + the ctrl+o expand shortcut, and a manual-then-auto approval
// round-trip to exercise the shift+tab live permission-mode toggle in both directions
// (including flipping it mid-task, while busy).
//
// Runs entirely in this one process, so the CLI's own `process.exit()` calls (typing "exit",
// or any fatal error) end the test process too — every assertion is checked, and success
// diagnostics are written with fs.writeSync(1, ...) (bypassing the fake stdout capture)
// *before* the final "type exit" step, specifically so a real failure surfaces as a thrown
// error / non-zero exit rather than being silently swallowed by that.
//
// Usage: node test/e2e-interactive-ui.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const REPO_ROOT = path.join(__dirname, '..');

function log(msg) {
  fs.writeSync(1, `[harness] ${msg}\n`);
}

function fail(msg) {
  fs.writeSync(1, `[harness] FAIL: ${msg}\n`);
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

async function waitUntil(checkFn, timeoutMs, label, debugFn) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = checkFn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (debugFn) fs.writeSync(1, `DEBUG: ${JSON.stringify(debugFn()).slice(-2000)}\n`);
  fail(`timed out waiting for: ${label}`);
}

async function main() {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-interactive-ui-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-interactive-ui-home-'));
  log(`scratch project dir: ${scratchDir}`);
  log(`isolated home dir: ${fakeHome}`);

  // cli/lib/server.js computes its well-known port-file directory from os.homedir() at
  // require-time — must be set before cli/index.js (and everything it requires) loads.
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  process.chdir(scratchDir);

  // The CLI's own cleanupAndExit() calls process.exit(0) directly once "exit" is typed —
  // this test runs in that same process, so there's no code path after that point to clean
  // up scratch dirs from. A synchronous process 'exit' listener is the only hook that still
  // runs at that point. Two things that bit on the first attempt, both fixed here: (1) an
  // exception thrown inside an 'exit' handler makes Node exit 1 regardless of what code the
  // process.exit() call that triggered it asked for, silently turning a real PASS into a
  // reported FAIL — wrapped in try/catch so a cleanup problem can never do that; (2) rmSync
  // on scratchDir failed with EBUSY because it was still this process's cwd (set below) —
  // chdir out of it first.
  process.on('exit', () => {
    try {
      process.chdir(REPO_ROOT);
      fs.rmSync(scratchDir, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    } catch (_) {
      // best-effort cleanup only — must never affect the process's actual exit code
    }
  });

  // --- Fake TTY stdout: captures everything written, byte-for-byte, into `screenBuffer`. ---
  const fakeOut = new PassThrough();
  fakeOut.isTTY = true;
  fakeOut.columns = 100;
  fakeOut.rows = 30;
  let screenBuffer = '';
  fakeOut.on('data', (d) => {
    screenBuffer += d.toString('utf8');
  });

  // --- Fake TTY stdin: readline drives real line-editing off this; we feed raw bytes to
  // simulate keystrokes (Enter = '\r', ctrl+o = the raw 0x0F control byte). ---
  const fakeIn = new PassThrough();
  fakeIn.isTTY = true;
  fakeIn.setRawMode = function setRawMode() {
    return fakeIn;
  };

  Object.defineProperty(process, 'stdout', { value: fakeOut, configurable: true, writable: true });
  Object.defineProperty(process, 'stdin', { value: fakeIn, configurable: true, writable: true });

  process.argv = ['node', path.join(REPO_ROOT, 'cli', 'index.js'), '--approve-all'];

  function typeText(text) {
    for (const ch of text) fakeIn.write(ch);
  }
  function pressEnter() {
    fakeIn.write('\r');
  }
  function pressCtrlO() {
    fakeIn.write(Buffer.from([0x0f]));
  }
  function pressShiftTab() {
    fakeIn.write('\x1b[Z'); // CSI "back-tab" — what a real terminal sends for shift+tab
  }

  log('requiring cli/index.js in-process with faked TTYs...');
  require(path.join(REPO_ROOT, 'cli', 'index.js'));

  // 1. The banner (a bordered box, printed unconditionally on the interactive path before
  // any network activity) should render immediately.
  await waitUntil(() => screenBuffer.includes('MyClaudeCode'), 5000, 'startup banner to render');
  // Deliberately stays on the REAL screen buffer (not the alternate one) so the terminal's
  // own scrollback keeps working — see cli/lib/screen.js's top-of-file comment for the
  // "unscrollable" bug this fixed. Assert the alt-screen sequence is NOT sent, rather than
  // asserting it is.
  assert(!screenBuffer.includes('\x1b[?1049h'), 'must stay on the real screen buffer, not switch to the alternate one');
  log('banner rendered, real screen buffer preserved (scrollback intact) — OK');

  // 2. Connect the fake "extension" over the CLI's own WebSocket protocol directly (see
  // cli/lib/server.js — no native-host/handshake needed, first connection wins).
  // PORT_FILE's exact filename now includes an install-scoped id (see cli/lib/server.js) —
  // read it from the already-required module (cached from requiring cli/index.js above,
  // computed with the fakeHome override already active) rather than duplicating that scheme
  // here, so this test can't drift out of sync with it again.
  const portFile = require(path.join(REPO_ROOT, 'cli', 'lib', 'server')).PORT_FILE;
  const port = await waitUntil(() => {
    if (!fs.existsSync(portFile)) return null;
    const p = fs.readFileSync(portFile, 'utf8').trim();
    return p || null;
  }, 5000, 'CLI to write its port file');
  log(`CLI listening on port ${port}, connecting fake extension...`);

  const WebSocket = require('ws');
  const { CLI_MESSAGE_TYPES } = require(path.join(REPO_ROOT, 'shared', 'protocol'));
  const { HOST_MESSAGE_TYPES } = require(path.join(REPO_ROOT, 'shared', 'protocol'));
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  // Handshake (see cli/lib/server.js's waitForConnection) — this fake extension stands in
  // for the real native host too, so it has to answer the HELLO itself, the same way
  // native-host/host.js does, or the CLI never trusts this connection and "Extension
  // connected" never fires. Registered BEFORE awaiting 'open', not after: the CLI can send
  // HELLO the instant the connection completes, and a listener attached only after that
  // (on a later tick, post-await) can miss a message that already arrived — EventEmitter
  // doesn't replay past emissions to listeners added later.
  const handshakeDone = new Promise((resolve) => {
    ws.once('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === HOST_MESSAGE_TYPES.HELLO) {
        ws.send(JSON.stringify({ type: HOST_MESSAGE_TYPES.HELLO_ACK, token: msg.token }));
      }
      resolve();
    });
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await handshakeDone;
  log('fake extension connected.');

  await waitUntil(() => screenBuffer.includes('Extension connected'), 5000, '"Extension connected" message');

  // 3. The pinned input box should now be drawn (readline/screen wiring only happens after
  // the extension connection resolves). Styled after Claude Code's own CLI: two plain
  // horizontal rules framing the input line, no side borders/corners.
  await waitUntil(() => screenBuffer.includes('─') && screenBuffer.includes('❯'), 5000, 'input box to render');
  log('pinned input box rendered — OK');

  // 3b. shift+tab should live-cycle the approval mode without restarting — like Claude
  // Code's own permission-mode toggle. Was started with --approve-all (auto), so one press
  // should flip the pinned status hint to manual.
  assert(screenBuffer.includes('auto-approve all'), 'should start in auto-approve mode (--approve-all)');
  screenBuffer = '';
  pressShiftTab();
  await waitUntil(() => screenBuffer.includes('manual approval'), 2000, 'shift+tab to flip the status hint to manual approval');
  log('shift+tab live-toggled auto-approve -> manual — OK');

  // 4. Type a task and submit it.
  screenBuffer = '';
  const taskText = 'do the thing';
  log(`typing task: "${taskText}"`);
  typeText(taskText);
  await waitUntil(() => screenBuffer.includes(taskText), 3000, 'typed text to appear live in the input box');
  log('live keystroke redraw into the box — OK');
  pressEnter();

  let sawRunTask = null;
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === CLI_MESSAGE_TYPES.RUN_TASK) sawRunTask = msg;
  });
  await waitUntil(() => sawRunTask, 5000, 'run_task message from the CLI', () => screenBuffer);
  assert(sawRunTask.task === taskText, `run_task should carry the typed task text, got "${sawRunTask.task}"`);
  const taskId = sawRunTask.taskId;
  log('run_task received by fake extension — OK');

  // 5. Script a short task: an approval round-trip (in the manual mode just toggled on,
  // then again after toggling back to auto mid-task), a long tool result (to exercise
  // truncation), then completion.
  function send(type, payload) {
    ws.send(JSON.stringify({ type, taskId, ...payload }));
  }
  const approvals = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === CLI_MESSAGE_TYPES.APPROVE_TOOL) approvals.set(msg.approvalId, msg);
  });

  send(CLI_MESSAGE_TYPES.THINKING_STARTED, { role: 'executor' });
  await new Promise((r) => setTimeout(r, 100));
  send(CLI_MESSAGE_TYPES.TOOL_CALL, { role: 'executor', tool: 'SHELL', params: { command: 'rm -rf sandbox' } });

  // 5a. Still in manual mode (toggled at step 3b) — a dangerous command should actually
  // prompt, not get silently auto-approved.
  screenBuffer = '';
  send(CLI_MESSAGE_TYPES.TOOL_APPROVAL_REQUIRED, { approvalId: 'appr-1', description: 'rm -rf sandbox' });
  await waitUntil(() => screenBuffer.includes('Approval required'), 3000, 'manual-mode approval prompt to appear');
  assert(!approvals.has('appr-1'), 'manual mode should NOT auto-approve — must wait for the y/N answer');
  log('manual mode correctly prompted instead of auto-approving — OK');

  typeText('y');
  pressEnter();
  await waitUntil(() => approvals.get('appr-1'), 3000, 'approve_tool response after answering y');
  assert(approvals.get('appr-1').approved === true, 'answering "y" should approve the tool call');
  log('manual approval round-trip (prompt -> y -> approved) — OK');

  // 5b. shift+tab back to auto-approve mid-task (busy mode) — the toggle isn't gated on
  // being idle, matching Claude Code letting you flip it any time.
  screenBuffer = '';
  pressShiftTab();
  await waitUntil(() => screenBuffer.includes('auto-approve all'), 2000, 'shift+tab to flip back to auto-approve mid-task');
  log('shift+tab live-toggled manual -> auto-approve, while busy — OK');

  send(CLI_MESSAGE_TYPES.TOOL_APPROVAL_REQUIRED, { approvalId: 'appr-2', description: 'sudo rm important-file' });
  await waitUntil(() => approvals.get('appr-2'), 3000, 'approve_tool to be sent automatically in auto-approve mode');
  assert(approvals.get('appr-2').approved === true, 'auto-approve mode should approve without a prompt');
  assert(screenBuffer.includes('Auto-approving'), 'auto-approve should be visibly logged, not silent');
  log('auto-approve mode approved without prompting — OK');

  const longResult = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of a big file`).join('\n');
  send(CLI_MESSAGE_TYPES.TOOL_CALL, { role: 'executor', tool: 'READ_FILE', params: { path: 'big.txt' } });
  send(CLI_MESSAGE_TYPES.TOOL_CALL_RESULT, {
    role: 'executor',
    tool: 'READ_FILE',
    params: { path: 'big.txt' },
    result: longResult,
  });
  send(CLI_MESSAGE_TYPES.TASK_COMPLETED, { summary: 'Read the big file successfully.' });

  await waitUntil(() => screenBuffer.includes('Task completed'), 5000, 'task_completed to render');
  log('task ran and completed — OK');

  // 6. The 60-line tool result should have collapsed to "+N lines (ctrl+o to expand)", not
  // been dumped in full.
  assert(screenBuffer.includes('ctrl+o to expand'), 'long tool result should have been truncated with a ctrl+o hint');
  assert(!screenBuffer.includes('line 59 of a big file'), 'truncated output should NOT contain line 59 (should be collapsed)');
  log('long output correctly truncated — OK');

  // 7. ctrl+o should reprint it in full.
  screenBuffer = '';
  pressCtrlO();
  await waitUntil(() => screenBuffer.includes('line 59 of a big file'), 3000, 'ctrl+o to expand the truncated result');
  assert(screenBuffer.includes('Expanded'), 'expand output should be labeled');
  log('ctrl+o expand — OK');

  // 8. The box should be back to idle and empty, ready for the next task.
  await waitUntil(() => screenBuffer.includes('Ready') || screenBuffer.includes('❯'), 3000, 'idle prompt to return');
  log('back to idle — OK');

  // 9. A terminal resize must not wipe or replay the conversation so far — it's real
  // scrollback the terminal already owns now (see cli/lib/screen.js's top-of-file comment),
  // so there is nothing to lose and nothing to replay. Only the box itself is width-
  // dependent, so a resize should just erase-and-redraw it in place at the new size, leaving
  // everything already printed above it completely untouched.
  screenBuffer = '';
  fakeOut.columns = 60;
  fakeOut.rows = 20;
  fakeOut.emit('resize');
  await waitUntil(() => screenBuffer.includes('─') && screenBuffer.includes('❯'), 2000, 'resize to redraw the input box at the new size');
  assert(!screenBuffer.includes('Task completed'), 'resize must NOT reprint prior conversation — it never left real scrollback');
  log('resize redrew only the box, left scrollback untouched — OK');

  log('ALL ASSERTIONS PASSED — typing "exit" to confirm clean shutdown...');
  typeText('exit');
  pressEnter();

  // cleanupAndExit() calls process.exit(0) itself once "exit" is processed — if that never
  // happens, something's wrong with shutdown; fail loudly instead of hanging forever.
  setTimeout(() => fail('CLI did not exit within 5s of typing "exit"'), 5000).unref();
}

main().catch((err) => {
  fs.writeSync(1, `[harness] FAILED: ${err.stack || err.message}\n`);
  process.exit(1);
});
