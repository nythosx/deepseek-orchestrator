// Shared message-type and tool-name constants used across cli/, native-host/, and extension/.
// Kept dependency-free (CommonJS + also usable via `var` fallback) so it can be copied
// into the extension bundle without a build step.
//
// This file is a hand-synced copy of ../../shared/protocol.js — the extension loads it via
// importScripts (classic script, no module resolution across arbitrary paths in an MV3
// service worker), so it can't just require() the real one. Observed live (2026-08-14): this
// copy had drifted out of sync with several TOOLS/CLI_MESSAGE_TYPES entries added to the
// shared original, silently no-op-ing the features that referenced them (RUN_HOOK, HASH_TREE,
// TASK_UPSERT/TASK_LIST, LOAD_RULES, LOAD_EXTERNAL_TOOLS, ENV_INFO all resolved to undefined
// here). Keep this an exact copy of shared/protocol.js whenever that file changes.

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
  CANCEL_TASK: 'cancel_task',
  TIMING: 'timing',
  TRIAGE_DECIDED: 'triage_decided',
  DIRECT_MODE_ESCALATED: 'direct_mode_escalated',
  PHASE_STARTED: 'phase_started',
  PHASE_SUCCESS: 'phase_success',
  PHASE_FAILED: 'phase_failed',
  ATTENTION_PING: 'attention_ping',
  MIGRATED: 'migrated',
  BRAIN_MIGRATED: 'brain_migrated',
  BUNDLE_TOO_LARGE: 'bundle_too_large',
  EXCLUSION_ROUND_STARTED: 'exclusion_round_started',
  EXCLUSION_ROUND_DONE: 'exclusion_round_done',
  RATE_LIMIT_DETECTED: 'rate_limit_detected',
};

const HOST_MESSAGE_TYPES = {
  CLI_TO_EXT: 'cli_to_ext',
  EXT_TO_CLI: 'ext_to_cli',
  EXEC_TOOL: 'exec_tool',
  TOOL_RESULT: 'tool_result',
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
  RUN_HOOK: 'RUN_HOOK',
  HASH_TREE: 'HASH_TREE',
  TASK_UPSERT: 'TASK_UPSERT',
  TASK_LIST: 'TASK_LIST',
  LOAD_RULES: 'LOAD_RULES',
  LOAD_EXTERNAL_TOOLS: 'LOAD_EXTERNAL_TOOLS',
  ENV_INFO: 'ENV_INFO',
  FILETRACK_SCAN: 'FILETRACK_SCAN',
  INSPECT_TAB: 'INSPECT_TAB',
  RESOLVE_IMAGE: 'RESOLVE_IMAGE',
  READ_IMAGE_CHUNK: 'READ_IMAGE_CHUNK',
  ATTACH_IMAGE: 'ATTACH_IMAGE',
  COMPILE_BUNDLE: 'COMPILE_BUNDLE',
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
  phased: {
    enabled: true,
    maxDirectLoc: 10000,
    targetLocPerPhase: 2000,
    phasesPerBrainPing: 3,
    apyMaxFixAttempts: 3,
    maxEscalationCycles: 2,
    bundleCharLimit: 2400000,
    targetedBundleMaxChars: 300000,
    exclusionRoundsMax: 3,
    rateLimitBackoffMs: [30000, 60000, 120000],
    postContinueGraceMs: 8000,
    brainMaxResponseChars: 10000,
  },
  filetrack: {
    enabled: false,
    bulkThreshold: 100,
    verbose: false,
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
