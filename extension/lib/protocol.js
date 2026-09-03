// Shared message-type and tool-name constants used across cli/, native-host/, and extension/.
// Kept dependency-free (CommonJS + also usable via `var` fallback) so it can be copied
// into the extension bundle without a build step.
//
// This file is a hand-synced copy of ../../shared/protocol.js — the extension loads it via
// importScripts (classic script, no module resolution across arbitrary paths in an MV3
// service worker), so it can't just require() the real one. Observed live (2026-08-14): this
// copy had drifted out of sync with several TOOLS/CLI_MESSAGE_TYPES entries added to the
// shared original, silently no-op-ing the features that referenced them (RUN_HOOK, HASH_TREE,
// TASK_UPSERT/TASK_LIST, LOAD_RULES, LOAD_EXTERNAL_TOOLS all resolved to undefined here).
// Keep this an exact copy of shared/protocol.js whenever that file changes.

const CLI_MESSAGE_TYPES = {
  RUN_TASK: 'run_task',
  APPROVE_TOOL: 'approve_tool',
  PLANNER_THINKING: 'planner_thinking',
  EXECUTOR_CODE: 'executor_code',
  THINKING_STARTED: 'thinking_started',
  TOOL_CALL: 'tool_call',
  TOOL_CALL_RESULT: 'tool_call_result',
  SUBTASK_STARTED: 'subtask_started',
  SUBTASK_FINISHED: 'subtask_finished',
  TOOL_APPROVAL_REQUIRED: 'tool_approval_required',
  QUALITY_GATE_FAILED: 'quality_gate_failed',
  TASK_COMPLETED: 'task_completed',
  TASK_ERROR: 'task_error',
  CLOSE_SESSION: 'close_session',
  SESSION_CLOSED: 'session_closed',
  USER_QUESTION_REQUIRED: 'user_question_required',
  ANSWER_USER_QUESTION: 'answer_user_question',
  // See shared/protocol.js's matching comment — keep this file an exact copy.
  CANCEL_TASK: 'cancel_task',
  // Diagnostic-only, --verbose-only (the CLI dumps every incoming message type under
  // --verbose with no per-type wiring needed — see cli/index.js's `<- ${JSON.stringify(msg)}`
  // — so this needed no CLI changes at all). Emitted around the two round trips that can
  // actually take real wall-clock time: a tab's reply (DeepSeek's own generation time, plus
  // our send/detect overhead) and a single tool call's native-host execution. Lets a slow
  // turn be attributed to "DeepSeek is slow to reply" vs. "a tool call/hook/gate is slow"
  // instead of guessing.
  TIMING: 'timing',
};

const HOST_MESSAGE_TYPES = {
  CLI_TO_EXT: 'cli_to_ext',
  EXT_TO_CLI: 'ext_to_cli',
  EXEC_TOOL: 'exec_tool',
  TOOL_RESULT: 'tool_result',
  // Handshake, sent directly over the raw CLI<->native-host WebSocket (never forwarded to
  // the extension) — see cli/lib/server.js's waitForConnection. Exists because a WebSocket
  // server bound to a well-known local port can be connected to by ANY process on the
  // machine that happens to try that same port number, not just this project's own native
  // host — observed live (2026-08-13): an unrelated project on the same machine, built from
  // the same template, blindly attempted this exact default port with no discovery-file
  // involved at all, so scoping the discovery file (also fixed, see PORT_FILE) doesn't by
  // itself rule this out. HELLO carries a random per-session token; only a connection that
  // echoes it back via HELLO_ACK is trusted as the real native host — anything else is
  // closed and the CLI keeps waiting for the next connection attempt instead.
  HELLO: 'hello',
  HELLO_ACK: 'hello_ack',
};

const TOOLS = {
  READ_FILE: 'READ_FILE',
  WRITE_FILE: 'WRITE_FILE',
  SHELL: 'SHELL',
  GREP: 'GREP',
  FIND_FILE: 'FIND_FILE',
  LS: 'LS',
  SEARCH_WEB: 'SEARCH_WEB',
  ASK_USER: 'ASK_USER',
  DELETE_FILE: 'DELETE_FILE',
  OPEN_APP: 'OPEN_APP',
  HTTP_GET: 'HTTP_GET',
  EDIT_FILE: 'EDIT_FILE',
  SHELL_BG: 'SHELL_BG',
  PROC_LIST: 'PROC_LIST',
  PROC_LOG: 'PROC_LOG',
  PROC_KILL: 'PROC_KILL',
  // Internal only — deliberately never added to toolCalls.js's parsing regex, so no chat
  // text (however the model formats it) can ever trigger one; only orchestrator.js's own
  // lifecycle-hook call sites invoke this, via NativeBridge.execTool directly.
  RUN_HOOK: 'RUN_HOOK',
  // Internal only, same reasoning as RUN_HOOK — never parsed from chat text.
  HASH_TREE: 'HASH_TREE',
  // Internal only, same reasoning as RUN_HOOK — the orchestrator maintains the task list
  // automatically from the [SUBTASK] lifecycle it already tracks, rather than relying on the
  // model to remember a bookkeeping tool call every time (see readme.md section 8).
  TASK_UPSERT: 'TASK_UPSERT',
  TASK_LIST: 'TASK_LIST',
  LOAD_RULES: 'LOAD_RULES',
  LOAD_EXTERNAL_TOOLS: 'LOAD_EXTERNAL_TOOLS',
};

const DEFAULT_CONFIG = {
  qualityGates: [],
  maxRetries: 5,
  chatLimitWarning: 5,
  stealth: {
    typingDelay: [50, 150],
    actionDelay: [200, 800],
    minMessageInterval: 2000,
    maxMessageInterval: 5000,
  },
};

const DEFAULT_PERMISSIONS = {
  dangerousCommands: ['rm', 'sudo', 'shutdown', 'reboot'],
  requireApproval: true,
  fileWriteOutsideProject: false,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CLI_MESSAGE_TYPES,
    HOST_MESSAGE_TYPES,
    TOOLS,
    DEFAULT_CONFIG,
    DEFAULT_PERMISSIONS,
  };
}
