#!/usr/bin/env node
// Native messaging host: bridges the Chrome extension (stdin/stdout) to the
// CLI's local WebSocket server, and executes file/shell tools on its behalf.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const { NativeMessaging } = require('./lib/native-messaging');
const tools = require('./lib/tools');
const persistentShell = require('./lib/persistentShell');
const { HOST_MESSAGE_TYPES, CLI_MESSAGE_TYPES, TOOLS } = require('../shared/protocol');

// Scoped to THIS installation's own on-disk path, not the target project the CLI happens to
// be run from (a separate, per-task concept) — see cli/lib/server.js's matching comment for
// the full story. Must resolve to the exact same id that computes: both sides hash their own
// project root (one level up from native-host/, two levels up from cli/lib/).
const INSTALL_ID = crypto.createHash('sha256').update(path.resolve(__dirname, '..')).digest('hex').slice(0, 12);
const PORT_FILE = path.join(os.homedir(), '.myclaudecode', `current_port_${INSTALL_ID}`);
const LOG_FILE = path.join(os.homedir(), '.myclaudecode', `host_${INSTALL_ID}.log`);

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {
    // logging is best-effort; native messaging stdout/stderr must stay clean
  }
}

const nm = new NativeMessaging(process.stdin, process.stdout);

// taskId -> { projectRoot, permissions, config }
const taskContexts = new Map();
// approvalId -> resolve(approved: boolean)
const pendingApprovals = new Map();

let ws = null;
let wsQueue = [];

function sendToCli(payload) {
  const json = JSON.stringify(payload);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(json);
  } else {
    wsQueue.push(json);
  }
}

// The extension's native port (and this process) can live for the whole Chrome
// session, long before any `my-claude-code` invocation exists. So this polls
// indefinitely rather than giving up after a few seconds, and re-polls after a
// disconnect in case a new CLI run starts up on a different port.
let currentPort = null;
const PORT_POLL_MS = 1000;

function pollForCli() {
  let port;
  try {
    port = fs.readFileSync(PORT_FILE, 'utf8').trim();
  } catch (_) {
    port = null;
  }

  const isConnected = ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
  if (port && (!isConnected || port !== currentPort)) {
    connectToCli(port);
  }

  setTimeout(pollForCli, PORT_POLL_MS);
}

function connectToCli(port) {
  currentPort = port;
  ws = new WebSocket(`ws://127.0.0.1:${port}`);

  ws.on('open', () => {
    log('Connected to CLI WebSocket server on port', port);
    wsQueue.forEach((json) => ws.send(json));
    wsQueue = [];
  });

  ws.on('message', (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch (err) {
      log('Malformed CLI message:', err.message);
      return;
    }
    // Handshake (see cli/lib/server.js's waitForConnection): echo the token straight back
    // so the CLI can trust this connection is actually this project's own native host, not
    // some unrelated process that happened to connect to the same well-known local port.
    // Never forwarded into handleCliPayload — it's not a real orchestration message.
    if (payload.type === HOST_MESSAGE_TYPES.HELLO) {
      ws.send(JSON.stringify({ type: HOST_MESSAGE_TYPES.HELLO_ACK, token: payload.token }));
      return;
    }
    handleCliPayload(payload);
  });

  ws.on('close', () => {
    log('CLI WebSocket connection closed.');
    ws = null;
    // Only one CLI connects at a time in this architecture, so its disconnecting means
    // this task is over — persistent shell sessions (and the state they hold) are no
    // longer useful and would just leak otherwise. Same reasoning for any SHELL_BG
    // processes: their owning task is gone, so nothing will ever list/kill them again.
    persistentShell.killAll();
    tools.killAllBackgroundProcsEverywhere();
  });

  ws.on('error', (err) => {
    log('CLI WebSocket error:', err.message);
  });
}

function handleCliPayload(payload) {
  if (payload.type === CLI_MESSAGE_TYPES.RUN_TASK) {
    taskContexts.set(payload.taskId, {
      projectRoot: payload.projectRoot || process.cwd(),
      permissions: payload.permissions || {},
      config: payload.config || {},
    });
  }

  if (payload.type === CLI_MESSAGE_TYPES.APPROVE_TOOL && pendingApprovals.has(payload.approvalId)) {
    const resolve = pendingApprovals.get(payload.approvalId);
    pendingApprovals.delete(payload.approvalId);
    resolve(!!payload.approved);
  }

  // Forward everything to the extension so it can drive the orchestration loop.
  nm.send({ type: HOST_MESSAGE_TYPES.CLI_TO_EXT, payload });
}

function requestApproval(taskId, description, extra) {
  const approvalId = crypto.randomUUID();
  sendToCli({
    type: CLI_MESSAGE_TYPES.TOOL_APPROVAL_REQUIRED,
    taskId,
    approvalId,
    description,
    ...extra,
  });
  return new Promise((resolve) => pendingApprovals.set(approvalId, resolve));
}

async function execTool(taskId, tool, params) {
  const ctx = taskContexts.get(taskId) || { projectRoot: process.cwd(), permissions: {} };
  const { projectRoot, permissions } = ctx;

  switch (tool) {
    case TOOLS.READ_FILE:
      return tools.readFile(projectRoot, params);

    case TOOLS.WRITE_FILE: {
      // No approval by default (unchanged) — only gated at all when a project has actually
      // configured permissions.rules with a WRITE_FILE(...) pattern (e.g. "WRITE_FILE(*.env)"
      // to ask before touching secrets). See tools.evaluatePermission's legacy fallback.
      const { verdict, matched } = tools.evaluatePermission(permissions, 'WRITE_FILE', params.path);
      if (verdict === 'deny') throw new Error(`Denied by permission rules (matched: ${matched}): "${params.path}" was not written.`);
      if (verdict === 'ask' && permissions.requireApproval !== false) {
        const approved = await requestApproval(taskId, `Write file: ${params.path}`, {
          tool: TOOLS.WRITE_FILE,
          command: `write ${params.path}`,
          matchedWord: matched,
          cwd: projectRoot,
        });
        if (!approved) return `Denied by user: "${params.path}" was not written.`;
      }
      return tools.writeFile(projectRoot, params, permissions);
    }

    case TOOLS.EDIT_FILE: {
      // Same approval tier as WRITE_FILE — opt-in only, via permissions.rules.
      const { verdict, matched } = tools.evaluatePermission(permissions, 'EDIT_FILE', params.path);
      if (verdict === 'deny') throw new Error(`Denied by permission rules (matched: ${matched}): "${params.path}" was not edited.`);
      if (verdict === 'ask' && permissions.requireApproval !== false) {
        const approved = await requestApproval(taskId, `Edit file: ${params.path}`, {
          tool: TOOLS.EDIT_FILE,
          command: `edit ${params.path}`,
          matchedWord: matched,
          cwd: projectRoot,
        });
        if (!approved) return `Denied by user: "${params.path}" was not edited.`;
      }
      return tools.editFile(projectRoot, params);
    }

    case TOOLS.DELETE_FILE: {
      // Unlike SHELL, this isn't gated on matching a dangerousCommands word — deletion is
      // unconditionally treated as needing approval (when approval is on at all), since
      // there's no "safe" delete the way there's a safe !LS or !READ_FILE. Still hard-scoped
      // to inside the project root regardless (see tools.deletePath — no override exists).
      if (permissions.requireApproval !== false) {
        const approved = await requestApproval(taskId, `Delete: ${params.path}`, {
          tool: TOOLS.DELETE_FILE,
          command: `delete ${params.path}`,
          matchedWord: 'delete',
          cwd: projectRoot,
        });
        if (!approved) return `Denied by user: "${params.path}" was not deleted.`;
      }
      return tools.deletePath(projectRoot, params);
    }

    case TOOLS.OPEN_APP: {
      // Known apps/bare URLs-and-files (see tools.isKnownAppCommand) are a small, fixed,
      // low-blast-radius set — no approval needed, same tier as read-only tools, UNLESS
      // permissions.rules explicitly says otherwise for this command. Anything else is an
      // arbitrary detached command, gated exactly like a dangerous SHELL command by default.
      let needsApproval;
      let matchedWord;
      if (permissions.rules) {
        const { verdict, matched } = tools.evaluatePermission(permissions, 'OPEN_APP', params.command);
        if (verdict === 'deny') return `Denied by permission rules (matched: ${matched}): "${params.command}" was not launched.`;
        if (verdict === 'ask') {
          needsApproval = true;
          matchedWord = matched;
        } else if (verdict === 'allow' && matched) {
          // An explicit allow rule overrides the default heuristic below.
          needsApproval = false;
        } else {
          needsApproval = !tools.isKnownAppCommand(params.command);
          matchedWord = 'open_app (unrecognized app/command)';
        }
      } else {
        needsApproval = !tools.isKnownAppCommand(params.command);
        matchedWord = 'open_app (unrecognized app/command)';
      }
      if (needsApproval && permissions.requireApproval !== false) {
        const approved = await requestApproval(taskId, `Launch: ${params.command}`, {
          tool: TOOLS.OPEN_APP,
          command: params.command,
          matchedWord,
          cwd: projectRoot,
        });
        if (!approved) return `Denied by user: "${params.command}" was not launched.`;
      }
      return tools.openApp(projectRoot, params);
    }

    case TOOLS.SHELL: {
      const { verdict, matched } = tools.evaluatePermission(permissions, 'SHELL', params.command);
      if (verdict === 'deny') {
        return { stdout: '', stderr: `Denied by permission rules (matched: ${matched}).`, exitCode: null, denied: true };
      }
      if (verdict === 'ask' && permissions.requireApproval !== false) {
        const approved = await requestApproval(taskId, `Run shell command: ${params.command}`, {
          tool: TOOLS.SHELL,
          command: params.command,
          matchedWord: matched,
          cwd: projectRoot,
        });
        if (!approved) {
          return { stdout: '', stderr: 'Denied by user.', exitCode: null, denied: true };
        }
      }
      // Quality-gate verification runs (orchestrator.js passes stateless:true for these)
      // deliberately bypass the persistent session — a gate should check a clean,
      // reproducible environment, not one polluted by whatever `cd`/`export` the model's
      // own exploratory shell commands left behind.
      if (params.stateless) {
        return tools.runShell(projectRoot, params);
      }
      const { shellPath, args, isCmd } = tools.resolvePersistentShell();
      const session = persistentShell.getOrCreateSession(taskId, projectRoot, shellPath, args, isCmd);
      return session.run(params.command);
    }

    case TOOLS.SHELL_BG: {
      // Same dangerous-command gate as SHELL — it's still an arbitrary command, just
      // non-blocking. Runs as its own detached-from-the-persistent-session process (see
      // tools.runBackgroundShell) so a long-lived dev server doesn't tie up the task's
      // regular `!SHELL` cd/export state.
      const { verdict, matched } = tools.evaluatePermission(permissions, 'SHELL_BG', params.command);
      if (verdict === 'deny') {
        return { denied: true, message: `Denied by permission rules (matched: ${matched}).` };
      }
      if (verdict === 'ask' && permissions.requireApproval !== false) {
        const approved = await requestApproval(taskId, `Run shell command in background: ${params.command}`, {
          tool: TOOLS.SHELL_BG,
          command: params.command,
          matchedWord: matched,
          cwd: projectRoot,
        });
        if (!approved) return { denied: true, message: 'Denied by user.' };
      }
      return tools.runBackgroundShell(projectRoot, taskId, params);
    }

    case TOOLS.PROC_LIST:
      return tools.procList(taskId);

    case TOOLS.PROC_LOG:
      return tools.procLog(taskId, params);

    case TOOLS.PROC_KILL:
      // Scoped to processes this task itself started via SHELL_BG — not an arbitrary system
      // PID — so no separate approval gate, same reasoning as SHELL running freely once past
      // the dangerous-word check.
      return tools.procKill(taskId, params);

    case TOOLS.GREP:
      return tools.grep(projectRoot, params);

    case TOOLS.FIND_FILE:
      return tools.findFile(projectRoot, params);

    case TOOLS.LS:
      return tools.ls(projectRoot, params);

    case TOOLS.HTTP_GET:
      // Read-only network check (like GREP/LS) — no approval gate.
      return tools.httpGet(projectRoot, params);

    case TOOLS.RUN_HOOK:
      // User-configured (config.json), not model-issued — never gated behind approval.
      return tools.runHook(projectRoot, params);

    case TOOLS.HASH_TREE:
      return tools.hashWorkingTree(projectRoot);

    case TOOLS.ENV_INFO:
      return tools.envInfo();

    case TOOLS.TASK_UPSERT:
      return tools.upsertTask(projectRoot, params);

    case TOOLS.TASK_LIST:
      return tools.listTasks(projectRoot);

    case TOOLS.LOAD_RULES:
      return tools.loadRuleFiles(projectRoot);

    case TOOLS.LOAD_EXTERNAL_TOOLS:
      return tools.loadExternalTools(projectRoot);

    case TOOLS.SEARCH_WEB:
      throw new Error('SEARCH_WEB must be handled by the extension directly, not the native host.');

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

nm.on('message', async (msg) => {
  if (msg.type === HOST_MESSAGE_TYPES.EXEC_TOOL) {
    try {
      const result = await execTool(msg.taskId, msg.tool, msg.params || {});
      nm.send({
        type: HOST_MESSAGE_TYPES.TOOL_RESULT,
        taskId: msg.taskId,
        requestId: msg.requestId,
        result,
        error: null,
      });
    } catch (err) {
      nm.send({
        type: HOST_MESSAGE_TYPES.TOOL_RESULT,
        taskId: msg.taskId,
        requestId: msg.requestId,
        result: null,
        error: err.message,
      });
    }
    return;
  }

  if (msg.type === HOST_MESSAGE_TYPES.EXT_TO_CLI) {
    sendToCli(msg.payload);
    return;
  }

  log('Unhandled message from extension:', JSON.stringify(msg));
});

nm.on('close', () => {
  log('stdin closed (Chrome disconnected). Exiting.');
  process.exit(0);
});

nm.on('error', (err) => log('Native messaging error:', err.message));

log('Native host started, pid', process.pid);
pollForCli();
