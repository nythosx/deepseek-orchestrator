#!/usr/bin/env node
// Verifies the "N consecutive unproductive responses -> migrate to a fresh tab" recovery
// path added to orchestrator.js's sendAndTrack/migrate (STALL_MIGRATION_THRESHOLD). Same
// Node-side stubbing technique as e2e-quality-gate.js/e2e-resume.js — drives the REAL
// extension/lib/orchestrator.js source directly, no browser needed. Unlike those two, the
// scripted responses are generated in-process here (not via fake-backend) so this test can
// precisely control exactly which tab said what, on which call.
//
// Usage: node test/e2e-stall-migration.js

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
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-stall-test-'));
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

  // Distinct incrementing tab ids per creation, so a migration (a genuinely new tab) is
  // observable and distinguishable from the original stuck one.
  let nextTabId = 1;
  const closedTabIds = [];
  let plannerTabId = null;
  let executorTabId = null;
  const callCounts = new Map(); // tabId -> reply count on that tab

  // Scenario: the FIRST executor tab (executor-2) gives 3 useless replies in a row — no
  // tool call, not DONE, just chatter — which should trip STALL_MIGRATION_THRESHOLD and
  // abandon it. The fresh post-migration executor tab then does the subtask for real.
  function scriptedResponse(tabId) {
    const n = (callCounts.get(tabId) || 0) + 1;
    callCounts.set(tabId, n);

    if (tabId === plannerTabId) {
      if (n === 1) return '[SUBTASK]Create hello.txt containing "Hello World".[/SUBTASK]';
      return '[MEMORY_UPDATE]\n- created hello.txt\n[/MEMORY_UPDATE]\nALL_DONE Summary: created hello.txt.';
    }
    if (tabId === 'executor-2') {
      return "I'm thinking about how to approach this.";
    }
    // Any executor tab created after the original (i.e. the post-migration one).
    if (n === 1) return '!WRITE_FILE hello.txt\n```text\nHello World\n```';
    return 'DONE Created hello.txt.';
  }

  global.TabManager = {
    createPlannerTab: async () => {
      plannerTabId = `planner-${nextTabId++}`;
      createdTabIds.add(plannerTabId);
      return plannerTabId;
    },
    createExecutorTab: async () => {
      executorTabId = `executor-${nextTabId++}`;
      createdTabIds.add(executorTabId);
      return executorTabId;
    },
    waitForReady: async () => true,
    checkSelectors: async () => [],
    closeTabs: async (...tabIds) => {
      closedTabIds.push(...tabIds);
    },
    sendToTabResilient: async (tabId, message) => global.TabManager.sendToTab(tabId, message),
    sendToTab: async (tabId, message) => {
      if (message.action === 'toggleWebSearch' || message.action === 'toggleDeepThink') return { toggled: true };
      if (message.action === 'editMessage') {
        // Migration's "summarize before I close this tab" request.
        return { text: 'Summary: still working on the subtask; nothing real done yet.' };
      }
      if (message.action !== 'typeAndSend') throw new Error(`Unsupported action in test double: ${message.action}`);
      return { text: scriptedResponse(tabId) };
    },
  };

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
      if (process.env.DEBUG_STALL) console.log('[debug sendToCli]', JSON.stringify(payload));
    },
  };

  const toolCallsSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension/lib/toolCalls.js'), 'utf8');
  const orchestratorSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension/lib/orchestrator.js'), 'utf8');
  const Orchestrator = new Function(`${toolCallsSrc}\n${orchestratorSrc}\nreturn Orchestrator;`)();

  const config = { qualityGates: [] };
  await Orchestrator.runTask(taskId, 'create hello.txt', {}, config, {}, projectRoot);

  assert(
    closedTabIds.includes('executor-2'),
    `expected the stuck original executor tab to be closed for migration, closed: ${JSON.stringify(closedTabIds)}`
  );
  assert(executorTabId === 'executor-3', `expected a fresh executor tab id after migration, got: ${executorTabId}`);
  // 1 primer send (direct TabManager call, not stall-tracked) + 1 subtask kickoff (resets
  // the streak) + 3 stall-tracked nudges (the 3rd one triggers migration instead of a 4th
  // send) = 4 total replies from the original tab before it's abandoned.
  assert((callCounts.get('executor-2') || 0) === 4, `expected exactly 4 replies from the stuck tab before migrating, got: ${callCounts.get('executor-2')}`);

  const helloPath = path.join(projectRoot, 'hello.txt');
  assert(fs.existsSync(helloPath), 'hello.txt should have been created by the post-migration executor tab');
  assert(fs.readFileSync(helloPath, 'utf8').trim() === 'Hello World', 'hello.txt should contain the expected content');

  console.log('\n[harness] PASS — 3 consecutive unproductive replies correctly triggered migration to a fresh executor tab, which finished the subtask for real.');
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[harness] FAILED:', err);
    process.exit(1);
  });
