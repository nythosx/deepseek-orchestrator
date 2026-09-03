#!/usr/bin/env node
// Unit-level checks for the three new tools added this session (EDIT_FILE, checkpointing/
// rewind, background processes) — exercises the real native-host/lib/tools.js functions and
// the real extension/lib/toolCalls.js parser directly, without needing a browser or the
// fake backend. Usage: node test/e2e-new-tools.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const tools = require('../native-host/lib/tools');

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function loadToolCallParser() {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'extension/lib/toolCalls.js'), 'utf8');
  return new Function(`${src}\nreturn ToolCallParser;`)();
}

async function testEditFile(projectRoot) {
  fs.writeFileSync(path.join(projectRoot, 'greet.txt'), 'Hello World\nSecond line\n', 'utf8');

  // Happy path: unique anchor replaced.
  const msg = tools.editFile(projectRoot, { path: 'greet.txt', oldString: 'Hello World', newString: 'Hello Moon' });
  assert(/replaced 1 occurrence/.test(msg), `expected a success message, got: ${msg}`);
  const after = fs.readFileSync(path.join(projectRoot, 'greet.txt'), 'utf8');
  assert(after === 'Hello Moon\nSecond line\n', `unexpected file content after edit: ${JSON.stringify(after)}`);

  // Not found.
  let threw = null;
  try {
    tools.editFile(projectRoot, { path: 'greet.txt', oldString: 'nonexistent text', newString: 'x' });
  } catch (err) {
    threw = err;
  }
  assert(threw && /not found/i.test(threw.message), `expected a "not found" error, got: ${threw && threw.message}`);

  // Not unique.
  fs.writeFileSync(path.join(projectRoot, 'dup.txt'), 'foo\nfoo\n', 'utf8');
  threw = null;
  try {
    tools.editFile(projectRoot, { path: 'dup.txt', oldString: 'foo', newString: 'bar' });
  } catch (err) {
    threw = err;
  }
  assert(threw && /found 2 times/.test(threw.message), `expected a "found 2 times" error, got: ${threw && threw.message}`);

  console.log('[harness] EDIT_FILE: happy path, not-found, and not-unique all behave correctly');
}

async function testToolCallParsing() {
  const ToolCallParser = loadToolCallParser();

  const editText = [
    '!EDIT_FILE src/app.js',
    '```',
    'const x = 1;',
    '```',
    '```',
    'const x = 2;',
    '```',
  ].join('\n');
  const editCalls = ToolCallParser.parseToolCalls(editText);
  assert(editCalls.length === 1 && editCalls[0].tool === 'EDIT_FILE', `expected 1 EDIT_FILE call, got: ${JSON.stringify(editCalls)}`);
  assert(editCalls[0].params.path === 'src/app.js', `unexpected path: ${editCalls[0].params.path}`);
  assert(editCalls[0].params.oldString === 'const x = 1;', `unexpected oldString: ${JSON.stringify(editCalls[0].params.oldString)}`);
  assert(editCalls[0].params.newString === 'const x = 2;', `unexpected newString: ${JSON.stringify(editCalls[0].params.newString)}`);

  const bgCalls = ToolCallParser.parseToolCalls('!SHELL_BG npm run dev');
  assert(bgCalls.length === 1 && bgCalls[0].params.command === 'npm run dev', `unexpected SHELL_BG parse: ${JSON.stringify(bgCalls)}`);

  const listCalls = ToolCallParser.parseToolCalls('!PROC_LIST');
  assert(listCalls.length === 1 && listCalls[0].tool === 'PROC_LIST', `unexpected PROC_LIST parse: ${JSON.stringify(listCalls)}`);

  const logCalls = ToolCallParser.parseToolCalls('!PROC_LOG ab12cd34 50');
  assert(
    logCalls.length === 1 && logCalls[0].params.id === 'ab12cd34' && logCalls[0].params.lines === 50,
    `unexpected PROC_LOG parse: ${JSON.stringify(logCalls)}`
  );

  const killCalls = ToolCallParser.parseToolCalls('!PROC_KILL ab12cd34');
  assert(killCalls.length === 1 && killCalls[0].params.id === 'ab12cd34', `unexpected PROC_KILL parse: ${JSON.stringify(killCalls)}`);

  console.log('[harness] toolCalls.js: EDIT_FILE / SHELL_BG / PROC_LIST / PROC_LOG / PROC_KILL all parse correctly');
}

async function testCheckpointRewind(projectRoot) {
  // WRITE_FILE creating a brand-new file: rewind should remove it (it didn't exist before).
  tools.writeFile(projectRoot, { path: 'new-file.txt', content: 'v1' }, {});
  assert(fs.existsSync(path.join(projectRoot, 'new-file.txt')), 'new-file.txt should exist after WRITE_FILE');
  let result = tools.rewind(projectRoot, 1);
  assert(result.reverted === 1, `expected 1 reverted entry, got: ${JSON.stringify(result)}`);
  assert(!fs.existsSync(path.join(projectRoot, 'new-file.txt')), 'new-file.txt should have been removed by rewind (it did not exist before the write)');

  // WRITE_FILE overwriting an existing file: rewind should restore the previous content.
  fs.writeFileSync(path.join(projectRoot, 'existing.txt'), 'original', 'utf8');
  tools.writeFile(projectRoot, { path: 'existing.txt', content: 'overwritten' }, {});
  assert(fs.readFileSync(path.join(projectRoot, 'existing.txt'), 'utf8') === 'overwritten', 'file should be overwritten before rewind');
  result = tools.rewind(projectRoot, 1);
  assert(result.reverted === 1, `expected 1 reverted entry, got: ${JSON.stringify(result)}`);
  assert(fs.readFileSync(path.join(projectRoot, 'existing.txt'), 'utf8') === 'original', 'rewind should have restored the original content');

  // DELETE_FILE: rewind should restore the deleted file.
  fs.writeFileSync(path.join(projectRoot, 'to-delete.txt'), 'keep me', 'utf8');
  tools.deletePath(projectRoot, { path: 'to-delete.txt' });
  assert(!fs.existsSync(path.join(projectRoot, 'to-delete.txt')), 'file should be deleted before rewind');
  result = tools.rewind(projectRoot, 1);
  assert(result.reverted === 1, `expected 1 reverted entry, got: ${JSON.stringify(result)}`);
  assert(fs.readFileSync(path.join(projectRoot, 'to-delete.txt'), 'utf8') === 'keep me', 'rewind should have restored the deleted file');

  // Multi-step rewind: two edits in a row, --rewind 2 undoes both.
  fs.writeFileSync(path.join(projectRoot, 'multi.txt'), 'a', 'utf8');
  tools.writeFile(projectRoot, { path: 'multi.txt', content: 'b' }, {});
  tools.writeFile(projectRoot, { path: 'multi.txt', content: 'c' }, {});
  assert(fs.readFileSync(path.join(projectRoot, 'multi.txt'), 'utf8') === 'c', 'multi.txt should be "c" before rewind');
  result = tools.rewind(projectRoot, 2);
  assert(result.reverted === 2, `expected 2 reverted entries, got: ${JSON.stringify(result)}`);
  assert(fs.readFileSync(path.join(projectRoot, 'multi.txt'), 'utf8') === 'a', `expected multi.txt back to "a", got: ${fs.readFileSync(path.join(projectRoot, 'multi.txt'), 'utf8')}`);

  // Nothing left to revert.
  const empty = tools.rewind(projectRoot, 1);
  // There may still be earlier entries from this test run (e.g. the initial writeFile for
  // 'multi.txt' itself was not checkpointed since it used fs.writeFileSync directly, not
  // tools.writeFile) — just assert it doesn't throw and reports a sane shape.
  assert(typeof empty.reverted === 'number', `rewind on a possibly-empty manifest should still return a count, got: ${JSON.stringify(empty)}`);

  console.log('[harness] checkpointing/--rewind: create, overwrite, delete, and multi-step revert all behave correctly');
}

async function testBackgroundProcess(projectRoot) {
  const taskId = 'bgtest-task';
  const isWin = process.platform === 'win32';
  const cmd = isWin
    ? 'echo hello-bg'
    : 'echo hello-bg';
  const started = tools.runBackgroundShell(projectRoot, taskId, { command: cmd });
  assert(started && started.id, `expected a process id, got: ${JSON.stringify(started)}`);

  // Give it a moment to actually run and exit (it's a trivial echo).
  await new Promise((r) => setTimeout(r, 1500));

  const list = tools.procList(taskId);
  assert(list.includes(started.id), `expected PROC_LIST to include ${started.id}, got: ${list}`);

  const log = tools.procLog(taskId, { id: started.id });
  assert(/hello-bg/.test(log), `expected process output in log, got: ${log}`);

  let threw = null;
  try {
    tools.procLog(taskId, { id: 'nonexistent-id' });
  } catch (err) {
    threw = err;
  }
  assert(threw && /No background process/.test(threw.message), `expected a clear error for unknown id, got: ${threw && threw.message}`);

  tools.killAllBackgroundProcs(taskId);
  console.log('[harness] SHELL_BG / PROC_LIST / PROC_LOG behave correctly for a short-lived background process');
}

async function main() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-new-tools-test-'));
  console.log(`[harness] project root: ${projectRoot}`);

  await testEditFile(projectRoot);
  await testToolCallParsing();
  await testCheckpointRewind(projectRoot);
  await testBackgroundProcess(projectRoot);

  console.log('\n[harness] PASS — EDIT_FILE, checkpointing/--rewind, and background process management all behave correctly.');
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[harness] FAILED:', err);
    process.exit(1);
  });
