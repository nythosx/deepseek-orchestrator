#!/usr/bin/env node
// End-to-end integration test for the CLI <-> native-host <-> "extension" <-> mock-backend
// pipeline. Stands in for the real Chrome extension by driving the fake-backend's HTTP API
// directly (instead of DOM automation) and speaking the exact native-messaging + tool-call
// protocol the real extension uses. Spawns fake-backend/server.js itself (see
// ensureFakeBackend below) and tears it down afterward — unless one's already listening on
// :8080, in which case it's reused as-is and left running (e.g. a dev server you started
// manually for iterating on scenarios).
//
// Usage: node test/e2e-mock.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const { NativeMessaging } = require('../native-host/lib/native-messaging');
const { HOST_MESSAGE_TYPES, CLI_MESSAGE_TYPES, TOOLS } = require('../shared/protocol');
const { withFakeBackend } = require('./lib/fakeBackend');

function loadToolCallParser() {
  const code = fs.readFileSync(path.join(REPO_ROOT, 'extension/lib/toolCalls.js'), 'utf8');
  return new Function(`${code}\nreturn ToolCallParser;`)();
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function fetchTurn(context, taskId) {
  const res = await fetch('http://localhost:8080/api/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '(driven by test harness)', context, taskId, scenario: 'default' }),
  });
  const data = await res.json();
  return data.reply;
}

async function main() {
  await withFakeBackend(runTest);
}

async function runTest() {
  const parser = loadToolCallParser();
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-e2e-'));
  console.log(`[harness] scratch project dir: ${scratchDir}`);

  // The CLI and native host discover each other via a port file under the user's real
  // home dir (~/.myclaudecode/current_port) — which the actual Chrome extension's
  // always-on host process also polls. Give this harness's child processes an isolated
  // fake home dir so it never races the real extension for that shared file.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-e2e-home-'));
  const childEnv = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
  console.log(`[harness] isolated home dir: ${fakeHome}`);

  // ensureFakeBackend's readiness probe already reset the mock backend's per-session turn
  // counters (pingFakeBackend hits the same /api/reset endpoint) — no separate call needed.

  const host = spawn('node', [path.join(REPO_ROOT, 'native-host', 'host.js')], {
    cwd: REPO_ROOT,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const nm = new NativeMessaging(host.stdout, host.stdin);

  const cli = spawn(
    'node',
    [path.join(REPO_ROOT, 'cli', 'index.js'), 'create a file named hello.txt', '--approve-all', '--verbose'],
    { cwd: scratchDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  cli.stdout.on('data', (d) => process.stdout.write(`[cli] ${d}`));
  cli.stderr.on('data', (d) => process.stderr.write(`[cli:err] ${d}`));

  const cliExit = new Promise((resolve) => cli.on('close', resolve));

  const pendingTools = new Map();
  let taskId = null;
  let sawTaskCompleted = false;

  function execTool(tool, params) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      pendingTools.set(requestId, { resolve, reject });
      nm.send({ type: HOST_MESSAGE_TYPES.EXEC_TOOL, taskId, tool, params, requestId });
    });
  }

  function sendToCli(payload) {
    nm.send({ type: HOST_MESSAGE_TYPES.EXT_TO_CLI, payload });
  }

  async function runScenario() {
    // Turn 0: the real orchestrator sends the executor primer as its own message before
    // any subtask (readme.md section 8) — mirror that so scenario turn indices line up.
    const primerAck = await fetchTurn('executor', taskId);
    console.log(`[harness] executor primer ack: ${primerAck}`);

    // Turn 1: planner explores with !LS
    let plannerText = await fetchTurn('planner', taskId);
    console.log(`[harness] planner turn 1: ${plannerText}`);
    for (const call of parser.parseToolCalls(plannerText)) {
      await execTool(call.tool, call.params);
    }

    // Turn 2: planner assigns the subtask
    plannerText = await fetchTurn('planner', taskId);
    console.log(`[harness] planner turn 2: ${plannerText}`);
    const subtask = parser.extractSubtask(plannerText);
    assert(subtask, 'planner should have emitted a [SUBTASK] block');

    // Executor turn 1: writes the file
    let executorText = await fetchTurn('executor', taskId);
    console.log(`[harness] executor turn 1: ${executorText}`);
    for (const call of parser.parseToolCalls(executorText)) {
      const result = await execTool(call.tool, call.params);
      console.log(`[harness] tool ${call.tool} ->`, result);
    }

    // Executor turn 2: DONE
    executorText = await fetchTurn('executor', taskId);
    console.log(`[harness] executor turn 2: ${executorText}`);
    assert(parser.isDone(executorText), 'executor should reply DONE');
    sendToCli({ type: CLI_MESSAGE_TYPES.EXECUTOR_CODE, taskId, summary: executorText });

    // Turn 3: planner wraps up with memory update + ALL_DONE
    plannerText = await fetchTurn('planner', taskId);
    console.log(`[harness] planner turn 3: ${plannerText}`);
    const memoryUpdate = parser.extractMemoryUpdate(plannerText);
    if (memoryUpdate) {
      await execTool(TOOLS.WRITE_FILE, { path: '.myclaudecode/memory.md', content: `${memoryUpdate}\n` });
    }
    assert(parser.isAllDone(plannerText), 'planner should reply ALL_DONE');
    sendToCli({ type: CLI_MESSAGE_TYPES.TASK_COMPLETED, taskId, summary: plannerText });
    sawTaskCompleted = true;
  }

  nm.on('message', (msg) => {
    if (msg.type === HOST_MESSAGE_TYPES.TOOL_RESULT) {
      const pending = pendingTools.get(msg.requestId);
      if (pending) {
        pendingTools.delete(msg.requestId);
        if (msg.error) pending.reject(new Error(msg.error));
        else pending.resolve(msg.result);
      }
      return;
    }
    if (msg.type === HOST_MESSAGE_TYPES.CLI_TO_EXT) {
      const payload = msg.payload;
      if (payload.type === CLI_MESSAGE_TYPES.RUN_TASK) {
        taskId = payload.taskId;
        console.log(`[harness] received run_task, taskId=${taskId}, projectRoot=${payload.projectRoot}`);
        runScenario().catch((err) => {
          console.error('[harness] scenario failed:', err);
          process.exitCode = 1;
        });
      }
      return;
    }
    console.log('[harness] unhandled message from host:', msg);
  });

  const exitCode = await cliExit;
  host.kill();

  assert(sawTaskCompleted, 'scenario should have reached ALL_DONE / task_completed');
  assert(exitCode === 0, `CLI should exit 0, got ${exitCode}`);

  const helloPath = path.join(scratchDir, 'hello.txt');
  assert(fs.existsSync(helloPath), `${helloPath} should have been created`);
  const content = fs.readFileSync(helloPath, 'utf8').trim();
  assert(content === 'Hello World', `hello.txt content should be "Hello World", got "${content}"`);

  const memoryPath = path.join(scratchDir, '.myclaudecode', 'memory.md');
  assert(fs.existsSync(memoryPath), 'memory.md should have been updated');

  console.log('\n[harness] PASS — full CLI <-> native-host <-> extension-protocol <-> mock-backend loop verified.');
  fs.rmSync(scratchDir, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[harness] FAILED:', err);
    process.exit(1);
  });
