#!/usr/bin/env node
// Verifies the "planner re-delegates the exact same [SUBTASK] it just got DONE for" guard
// added to orchestrator.js's runTask loop (REPEATED_SUBTASK_THRESHOLD/REPEATED_SUBTASK_NOTE)
// — covers readme.md's known gap: "the planner occasionally re-delegates a subtask the
// executor already finished." Same Node-side stubbing technique as e2e-stall-migration.js:
// drives the REAL extension/lib/orchestrator.js source directly, in-process scripted
// responses, no browser/fake-backend needed.
//
// Usage: node test/e2e-loop-guard.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.join(__dirname, '..');
const tools = require('../native-host/lib/tools');

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function main() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-loopguard-test-'));
  console.log(`[harness] project root: ${projectRoot}`);

  const taskId = crypto.randomUUID();

  global.TOOLS = require('../shared/protocol').TOOLS;
  global.CLI_MESSAGE_TYPES = require('../shared/protocol').CLI_MESSAGE_TYPES;

  const fakeStorage = new Map();
  const createdTabIds = new Set();
  global.chrome = {
    storage: {
      local: {
        get: async (key) => ({ [key]: fakeStorage.get(key) }),
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) fakeStorage.set(k, v);
        },
        remove: async (key) => fakeStorage.delete(key),
      },
    },
    tabs: {
      get: async (tabId) => {
        if (createdTabIds.has(tabId)) return { id: tabId };
        throw new Error('No such tab.');
      },
    },
  };

  const plannerTabId = 'planner-1';
  const executorTabId = 'executor-1';
  createdTabIds.add(plannerTabId);
  createdTabIds.add(executorTabId);

  const callCounts = new Map(); // tabId -> reply count on that tab
  const sentToPlanner = []; // full text of every message sent TO the planner tab

  const SUBTASK = '[SUBTASK]Create hello.txt containing "Hello World".[/SUBTASK]';

  // Scenario: the planner dispatches the same subtask twice in a row (simulating the
  // observed-live confusion bug) right after the executor already reported it DONE. The
  // guard should intercept the second identical dispatch with a system nudge instead of
  // sending the executor to do the same work again — and the planner then wraps up normally.
  //
  // The executor tab's very first send is the primer itself (sent directly via
  // TabManager.sendToTabResilient before runExecutorSubtask ever runs — see runTask), not
  // the subtask — that reply is never parsed for tool calls, so it's answered separately
  // here and excluded from callCounts, which then only reflects real subtask exchanges.
  function scriptedResponse(tabId, text) {
    if (tabId === executorTabId && /You are a coding agent/.test(text || '')) {
      return 'OK, ready.';
    }
    const n = (callCounts.get(tabId) || 0) + 1;
    callCounts.set(tabId, n);

    if (tabId === plannerTabId) {
      if (n === 1) return SUBTASK;
      if (n === 2) return SUBTASK; // deliberately repeats — this is what the guard must catch
      return 'ALL_DONE Summary: hello.txt already created.';
    }
    // executor
    if (n === 1) return '!WRITE_FILE hello.txt\n```text\nHello World\n```';
    return 'DONE Created hello.txt.';
  }

  global.TabManager = {
    createPlannerTab: async () => plannerTabId,
    createExecutorTab: async () => executorTabId,
    waitForReady: async () => true,
    checkSelectors: async () => [],
    closeTabs: async () => {},
    sendToTabResilient: async (tabId, message) => global.TabManager.sendToTab(tabId, message),
    sendToTab: async (tabId, message) => {
      if (message.action === 'toggleWebSearch' || message.action === 'toggleDeepThink') return { toggled: true };
      if (message.action !== 'typeAndSend') throw new Error(`Unsupported action in test double: ${message.action}`);
      if (tabId === plannerTabId) sentToPlanner.push(message.text);
      return { text: scriptedResponse(tabId, message.text) };
    },
  };

  const cliMessages = [];
  global.NativeBridge = {
    execTool: async (tid, tool, params) => {
      switch (tool) {
        case 'READ_FILE':
          return tools.readFile(projectRoot, params);
        case 'WRITE_FILE':
          return tools.writeFile(projectRoot, params, {});
        case 'SHELL':
          return tools.runShell(projectRoot, params);
        case 'LS':
          return tools.ls(projectRoot, params);
        default:
          throw new Error(`Unknown tool in this test: ${tool}`);
      }
    },
    sendToCli: (payload) => {
      cliMessages.push(payload);
      if (process.env.DEBUG_LOOPGUARD) console.log('[debug sendToCli]', JSON.stringify(payload));
    },
  };

  const toolCallsSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension/lib/toolCalls.js'), 'utf8');
  const orchestratorSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension/lib/orchestrator.js'), 'utf8');
  const Orchestrator = new Function(`${toolCallsSrc}\n${orchestratorSrc}\nreturn Orchestrator;`)();

  const config = { qualityGates: [] };
  await Orchestrator.runTask(taskId, 'create hello.txt', {}, config, {}, projectRoot);

  const subtaskStarts = cliMessages.filter((m) => m.type === CLI_MESSAGE_TYPES.SUBTASK_STARTED);
  assert(
    subtaskStarts.length === 1,
    `expected the repeated [SUBTASK] to be intercepted (only 1 real dispatch), got ${subtaskStarts.length}: ${JSON.stringify(subtaskStarts)}`
  );

  assert((callCounts.get(executorTabId) || 0) === 2, `executor should only have been engaged once (2 replies for the one real subtask), got ${callCounts.get(executorTabId)}`);

  const nudgeSent = sentToPlanner.some((t) => /dispatched this exact same \[SUBTASK\] again/.test(t || ''));
  assert(nudgeSent, `expected the planner to receive the repeated-subtask system nudge, got sent texts: ${JSON.stringify(sentToPlanner)}`);

  const completed = cliMessages.find((m) => m.type === CLI_MESSAGE_TYPES.TASK_COMPLETED);
  assert(completed, 'task should still complete normally after the guard intervenes');

  const helloPath = path.join(projectRoot, 'hello.txt');
  assert(fs.existsSync(helloPath), 'hello.txt should have been created exactly once');
  assert(fs.readFileSync(helloPath, 'utf8').trim() === 'Hello World', 'hello.txt should contain the expected content');

  console.log('\n[harness] PASS — an immediately-repeated identical [SUBTASK] was intercepted with a system nudge instead of looping, and the task still completed correctly.');
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[harness] FAILED:', err);
    process.exit(1);
  });
