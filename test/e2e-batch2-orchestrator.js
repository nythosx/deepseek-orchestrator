#!/usr/bin/env node
// Node-stub scenario tests for the orchestrator-level behaviors added in the second report
// batch (recommendations 4-14) that need a real (scripted) planner/executor exchange to
// exercise: the plan-approval gate and a preToolUse hook blocking a tool call. Same
// technique as e2e-loop-guard.js/e2e-stall-migration.js — drives the REAL
// extension/lib/orchestrator.js source directly with in-process stand-ins for the
// browser-only APIs. Usage: node test/e2e-batch2-orchestrator.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.join(__dirname, '..');
const tools = require('../native-host/lib/tools');

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function loadOrchestrator() {
  const toolCallsSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension/lib/toolCalls.js'), 'utf8');
  const orchestratorSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension/lib/orchestrator.js'), 'utf8');
  return new Function(`${toolCallsSrc}\n${orchestratorSrc}\nreturn Orchestrator;`)();
}

function baseGlobals() {
  global.TOOLS = require('../shared/protocol').TOOLS;
  global.CLI_MESSAGE_TYPES = require('../shared/protocol').CLI_MESSAGE_TYPES;
  global.chrome = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    tabs: { get: async () => ({ id: 1 }) },
  };
}

async function testPlanApproval() {
  baseGlobals();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-plan-approval-'));
  const taskId = crypto.randomUUID();
  const plannerTabId = 'planner-1';
  const executorTabId = 'executor-1';
  const callCounts = new Map();

  function scriptedResponse(tabId, text) {
    if (tabId === executorTabId && /You are a coding agent/.test(text || '')) return 'OK, ready.';
    const n = (callCounts.get(tabId) || 0) + 1;
    callCounts.set(tabId, n);
    if (tabId === plannerTabId) {
      if (n === 1) return '[PLAN]\n- Step 1: create hello.txt\n[/PLAN]';
      if (n === 2) return '[SUBTASK]Create hello.txt containing "Hello World".[/SUBTASK]';
      return 'ALL_DONE Summary: done.';
    }
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
      return { text: scriptedResponse(tabId, message.text) };
    },
  };

  const cliMessages = [];
  let pendingQuestionId = null;
  const Orchestrator = loadOrchestrator();
  global.NativeBridge = {
    execTool: async (tid, tool, params) => {
      switch (tool) {
        case 'READ_FILE':
          return tools.readFile(projectRoot, params);
        case 'WRITE_FILE':
          return tools.writeFile(projectRoot, params, {});
        case 'LS':
          return tools.ls(projectRoot, params);
        case 'HASH_TREE':
          return tools.hashWorkingTree(projectRoot);
        case 'LOAD_RULES':
          return tools.loadRuleFiles(projectRoot);
        case 'LOAD_EXTERNAL_TOOLS':
          return tools.loadExternalTools(projectRoot);
        case 'TASK_UPSERT':
          return tools.upsertTask(projectRoot, params);
        case 'TASK_LIST':
          return tools.listTasks(projectRoot);
        default:
          throw new Error(`unexpected tool: ${tool}`);
      }
    },
    sendToCli: (payload) => {
      cliMessages.push(payload);
      if (payload.type === CLI_MESSAGE_TYPES.USER_QUESTION_REQUIRED) {
        pendingQuestionId = payload.questionId;
        setImmediate(() => Orchestrator.answerQuestion(pendingQuestionId, 'Approve'));
      }
    },
  };

  const config = { qualityGates: [], requirePlanApproval: true };
  await Orchestrator.runTask(taskId, 'create hello.txt', {}, config, {}, projectRoot);

  const askedQuestion = cliMessages.find((m) => m.type === CLI_MESSAGE_TYPES.USER_QUESTION_REQUIRED);
  assert(askedQuestion, 'expected the plan to be presented for approval via ASK_USER');
  assert(/Step 1: create hello.txt/.test(askedQuestion.question), `expected the plan text in the question, got: ${askedQuestion.question}`);
  assert(cliMessages.some((m) => m.type === CLI_MESSAGE_TYPES.TASK_COMPLETED), 'task should complete after plan approval');
  assert(fs.existsSync(path.join(projectRoot, 'hello.txt')), 'hello.txt should have been created after approval');

  console.log('[harness] plan-approval gate: plan presented, approved, and the subtask still dispatched the same turn');
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

async function testPreToolUseHookBlocks() {
  baseGlobals();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-hook-block-'));
  const taskId = crypto.randomUUID();
  const plannerTabId = 'planner-1';
  const executorTabId = 'executor-1';
  const callCounts = new Map();

  // A hook that always exits 2 (block) — bounded to the actual OS shell so this test
  // exercises the real tools.runHook spawn path, not a fake.
  const isWin = process.platform === 'win32';
  const blockingHookCommand = isWin ? 'exit 2' : 'exit 2';

  function scriptedResponse(tabId, text) {
    if (tabId === executorTabId && /You are a coding agent/.test(text || '')) return 'OK, ready.';
    const n = (callCounts.get(tabId) || 0) + 1;
    callCounts.set(tabId, n);
    if (tabId === plannerTabId) {
      if (n === 1) return '[SUBTASK]Write hello.txt.[/SUBTASK]';
      return 'ALL_DONE Summary: done.';
    }
    // Executor: first turn tries to write a file (should be blocked by the hook), then
    // reports DONE regardless (this test only cares that the write never actually happened).
    if (n === 1) return '!WRITE_FILE hello.txt\n```text\nHello World\n```';
    return 'DONE Attempted the write.';
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
        case 'LS':
          return tools.ls(projectRoot, params);
        case 'HASH_TREE':
          return tools.hashWorkingTree(projectRoot);
        case 'LOAD_RULES':
          return tools.loadRuleFiles(projectRoot);
        case 'LOAD_EXTERNAL_TOOLS':
          return tools.loadExternalTools(projectRoot);
        case 'TASK_UPSERT':
          return tools.upsertTask(projectRoot, params);
        case 'TASK_LIST':
          return tools.listTasks(projectRoot);
        case 'RUN_HOOK':
          return tools.runHook(projectRoot, params);
        default:
          throw new Error(`unexpected tool: ${tool}`);
      }
    },
    sendToCli: (payload) => cliMessages.push(payload),
  };

  const Orchestrator = loadOrchestrator();
  const config = { qualityGates: [], hooks: { preToolUse: blockingHookCommand } };
  await Orchestrator.runTask(taskId, 'write hello.txt', {}, config, {}, projectRoot);

  assert(!fs.existsSync(path.join(projectRoot, 'hello.txt')), 'preToolUse hook should have blocked the write — hello.txt must not exist');
  const blockedResult = cliMessages.find(
    (m) => m.type === CLI_MESSAGE_TYPES.TOOL_CALL_RESULT && m.error && /Blocked by preToolUse hook/.test(m.error)
  );
  assert(blockedResult, `expected a tool_call_result reporting the block, got: ${JSON.stringify(cliMessages.filter((m) => m.type === CLI_MESSAGE_TYPES.TOOL_CALL_RESULT))}`);

  console.log('[harness] preToolUse hook: a blocking hook (exit 2) correctly prevented the tool call from running');
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

async function main() {
  await testPlanApproval();
  await testPreToolUseHookBlocks();
  console.log('\n[harness] PASS — plan-approval gate and preToolUse hook blocking both behave correctly.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[harness] FAILED:', err);
    process.exit(1);
  });
