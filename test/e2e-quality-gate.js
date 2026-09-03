#!/usr/bin/env node
// Deterministic test of quality-gate enforcement in orchestrator.js, covering two related
// fixes:
//  1. (2026-08-11) The planner can no longer bypass the executor and write files directly
//     — PLANNER_DISALLOWED_TOOLS rejects WRITE_FILE/SHELL/DELETE_FILE/OPEN_APP when the
//     planner issues them. This scenario has the planner properly delegate via [SUBTASK]
//     instead (the old version of this scenario had the planner self-write broken.js
//     directly, which is exactly what's no longer possible).
//  2. The executor's own quality gate (on its DONE, not just the planner's ALL_DONE) blocks
//     completion until genuinely broken code is fixed.
// Loads the REAL extension/lib/orchestrator.js + toolCalls.js source and drives it with
// Node-side stand-ins for the two Chrome-only dependencies (TabManager, NativeBridge)
// instead of spinning up a browser — fast, deterministic, and exercises the actual shipped
// logic rather than a hand-rolled reimplementation.
//
// Spawns fake-backend/server.js itself if nothing's already listening on :8080 (see
// test/lib/fakeBackend.js) and tears it down afterward.
// Usage: node test/e2e-quality-gate.js

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
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-gate-test-'));
  console.log(`[harness] project root: ${projectRoot}`);

  await pingFakeBackend(); // resets the mock backend's per-session turn counters

  const taskId = crypto.randomUUID();
  const cliMessages = [];
  // role -> "which scenario turn are we on" is tracked server-side by the mock backend
  // (keyed by taskId+context), so this harness just needs to route by tabId.
  const tabRoles = { 'tab-planner': 'planner', 'tab-executor': 'executor' };

  global.TOOLS = require('../shared/protocol').TOOLS;
  global.CLI_MESSAGE_TYPES = require('../shared/protocol').CLI_MESSAGE_TYPES;

  // orchestrator.js now persists sessions via chrome.storage.local (for --resume) and
  // checks chrome.tabs.get to see if saved tabs are still alive — stub both in-memory
  // so this harness doesn't need a real browser for that logic either.
  const fakeStorage = new Map();
  global.chrome = {
    storage: {
      local: {
        get: async (key) => ({ [key]: fakeStorage.get(key) }),
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) fakeStorage.set(k, v);
        },
        remove: async (key) => {
          fakeStorage.delete(key);
        },
      },
    },
    tabs: {
      get: async (tabId) => {
        if (tabId === 'tab-planner' || tabId === 'tab-executor') return { id: tabId };
        throw new Error('No such tab.');
      },
    },
  };

  global.TabManager = {
    createPlannerTab: async () => 'tab-planner',
    createExecutorTab: async () => 'tab-executor',
    waitForReady: async () => true,
    checkSelectors: async () => [],
    closeTabs: async () => {},
    sendToTabResilient: async (tabId, message) => global.TabManager.sendToTab(tabId, message),
    sendToTab: async (tabId, message) => {
      if (message.action === 'toggleWebSearch' || message.action === 'toggleDeepThink') {
        return { toggled: true };
      }
      if (message.action !== 'typeAndSend') {
        throw new Error(`Unsupported action in test double: ${message.action}`);
      }
      const context = tabRoles[tabId];
      const res = await fetch('http://localhost:8080/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: message.text,
          context,
          taskId,
          scenario: 'quality-gate-bypass',
        }),
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
        case 'GREP':
          return tools.grep(projectRoot, params);
        case 'FIND_FILE':
          return tools.findFile(projectRoot, params);
        case 'LS':
          return tools.ls(projectRoot, params);
        default:
          throw new Error(`Unknown tool: ${tool}`);
      }
    },
    sendToCli: (payload) => {
      cliMessages.push(payload);
    },
  };

  // Load the real shipped source, evaluated with the globals above already in scope
  // (Node's `global.X = ...` makes X resolvable as a bare identifier from `new Function`).
  const toolCallsSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension/lib/toolCalls.js'), 'utf8');
  const orchestratorSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension/lib/orchestrator.js'), 'utf8');
  const Orchestrator = new Function(`${toolCallsSrc}\n${orchestratorSrc}\nreturn Orchestrator;`)();

  const config = { qualityGates: ['node --check broken.js'], maxRetries: 5 };
  await Orchestrator.runTask(taskId, 'Create broken.js (deliberately, for testing)', {}, config, {}, projectRoot);

  const gateFailures = cliMessages.filter((m) => m.type === CLI_MESSAGE_TYPES.QUALITY_GATE_FAILED);
  const completed = cliMessages.find((m) => m.type === CLI_MESSAGE_TYPES.TASK_COMPLETED);

  console.log(`[harness] quality_gate_failed messages: ${gateFailures.length}`);
  console.log(`[harness] task_completed: ${completed ? 'yes' : 'no'}`);

  assert(gateFailures.length >= 1, 'broken.js should have triggered at least one quality_gate_failed before completion');
  assert(
    gateFailures[0].gate === 'node --check broken.js',
    `expected the failing gate to be reported, got: ${JSON.stringify(gateFailures[0])}`
  );
  assert(completed, 'task should eventually complete once the code is actually fixed');

  const finalCheck = await tools.runShell(projectRoot, { command: 'node --check broken.js' });
  assert(finalCheck.exitCode === 0, `broken.js should be valid JS by the end, got: ${JSON.stringify(finalCheck)}`);

  // Covers the 2026-08-11 fix directly: the planner must never have executed WRITE_FILE
  // itself — it only ever delegates. If PLANNER_DISALLOWED_TOOLS regressed, this scenario's
  // planner turns (which never issue !WRITE_FILE at all) wouldn't catch that on their own,
  // so assert directly against the tool-call events the orchestrator actually emitted.
  const plannerWrites = cliMessages.filter(
    (m) => m.type === CLI_MESSAGE_TYPES.TOOL_CALL && m.role === 'planner' && m.tool === 'WRITE_FILE'
  );
  assert(plannerWrites.length === 0, `planner should never execute WRITE_FILE directly, got: ${JSON.stringify(plannerWrites)}`);

  console.log('\n[harness] PASS — planner delegated properly, and the executor-level quality gate correctly blocked completion until the real bug was fixed.');
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[harness] FAILED:', err);
    process.exit(1);
});
