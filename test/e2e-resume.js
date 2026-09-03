#!/usr/bin/env node
// Deterministic test of session persistence + --resume + --close-session, driving the
// REAL orchestrator.js source with Node-side stand-ins for chrome.storage/chrome.tabs
// (same technique as e2e-quality-gate.js). Proves:
//   1. A completed task saves its session (tabs stay open, not closed).
//   2. A --resume run reattaches to those tabs and skips re-priming — it hands the new
//      task straight to the existing conversation instead of sending the full primer again.
//   3. --close-session closes the saved tabs and forgets the session.
//
// Spawns fake-backend/server.js itself if nothing's already listening on :8080 (see
// test/lib/fakeBackend.js) and tears it down afterward.
// Usage: node test/e2e-resume.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.join(__dirname, '..');
const tools = require('../native-host/lib/tools');
const { withFakeBackend, pingFakeBackend } = require('./lib/fakeBackend');

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function main() {
  await withFakeBackend(runTest);
}

async function runTest() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-resume-test-'));
  console.log(`[harness] project root: ${projectRoot}`);
  await pingFakeBackend(); // resets the mock backend's per-session turn counters

  global.TOOLS = require('../shared/protocol').TOOLS;
  global.CLI_MESSAGE_TYPES = require('../shared/protocol').CLI_MESSAGE_TYPES;

  const fakeStorage = new Map();
  const sentMessages = []; // { tabId, action, text }
  const closedTabCalls = [];

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
        if (tabId === 1001 || tabId === 1002) return { id: tabId };
        throw new Error('No such tab.');
      },
    },
  };

  const tabRoles = { 1001: 'planner', 1002: 'executor' };
  let currentTaskId = null;

  global.TabManager = {
    createPlannerTab: async () => 1001,
    createExecutorTab: async () => 1002,
    waitForReady: async () => true,
    checkSelectors: async () => [],
    closeTabs: async (...tabIds) => {
      closedTabCalls.push(tabIds);
    },
    sendToTabResilient: async (tabId, message) => global.TabManager.sendToTab(tabId, message),
    sendToTab: async (tabId, message) => {
      if (message.action === 'toggleWebSearch' || message.action === 'toggleDeepThink') {
        return { toggled: true };
      }
      sentMessages.push({ tabId, action: message.action, text: message.text });
      const context = tabRoles[tabId];
      const res = await fetch('http://localhost:8080/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: message.text, context, taskId: currentTaskId, scenario: 'default' }),
      });
      const data = await res.json();
      return { text: data.reply };
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
      if (process.env.DEBUG_RESUME) console.log('[debug sendToCli]', JSON.stringify(payload));
    },
  };

  const toolCallsSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension/lib/toolCalls.js'), 'utf8');
  const orchestratorSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension/lib/orchestrator.js'), 'utf8');
  const Orchestrator = new Function(`${toolCallsSrc}\n${orchestratorSrc}\nreturn Orchestrator;`)();

  const config = { qualityGates: [] };
  const sessionKey = `session:${projectRoot}`;

  // --- Run 1: fresh task, should complete and SAVE (not close) the session ---
  currentTaskId = crypto.randomUUID();
  assert(!fakeStorage.has(sessionKey), 'no session should exist before the first run');
  await Orchestrator.runTask(currentTaskId, 'create a file named hello.txt', {}, config, {}, projectRoot);

  assert(closedTabCalls.length === 0, 'tabs should NOT be closed on a normal completion anymore');
  assert(fakeStorage.has(sessionKey), 'a session should be saved after completion');
  const saved = fakeStorage.get(sessionKey);
  assert(saved.plannerTabId === 1001 && saved.executorTabId === 1002, 'saved tab ids should match');
  console.log('[harness] run 1: session correctly saved instead of tabs being closed');

  // --- Run 2: --resume, same project — should reattach and skip re-priming ---
  await fetch('http://localhost:8080/api/reset', { method: 'POST' });
  sentMessages.length = 0;
  currentTaskId = crypto.randomUUID();
  await Orchestrator.runTask(
    currentTaskId,
    'now also create a second file',
    { resume: true },
    config,
    {},
    projectRoot
  );

  const executorPrimerSends = sentMessages.filter(
    (m) => m.tabId === 1002 && m.action === 'typeAndSend' && /You are a coding agent/.test(m.text || '')
  );
  assert(executorPrimerSends.length === 0, 'resumed run should NOT re-send the executor primer');
  const firstPlannerSend = sentMessages.find((m) => m.tabId === 1001);
  assert(
    firstPlannerSend && /^New task from the user:/.test(firstPlannerSend.text),
    `resumed run's first planner message should hand off the new task directly, got: ${JSON.stringify(firstPlannerSend)}`
  );
  console.log('[harness] run 2: --resume correctly skipped re-priming and reused the existing tabs');

  // --- --close-session: should close the saved tabs and forget the session ---
  const closeResult = await Orchestrator.closeSession(projectRoot);
  assert(closeResult.closed === true, 'closeSession should report closed:true when a session existed');
  assert(!fakeStorage.has(sessionKey), 'session record should be removed after closeSession');
  assert(closedTabCalls.length === 1, 'closeSession should have closed exactly one pair of tabs');
  console.log('[harness] --close-session: correctly closed tabs and forgot the session');

  const closeAgain = await Orchestrator.closeSession(projectRoot);
  assert(closeAgain.closed === false, 'closing an already-forgotten session should report closed:false');

  console.log('\n[harness] PASS — session persistence, --resume, and --close-session all behave correctly.');
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[harness] FAILED:', err);
    process.exit(1);
  });
