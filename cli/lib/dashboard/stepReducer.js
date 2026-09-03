// Turns the raw --json event stream (see shared/protocol.js CLI_MESSAGE_TYPES) into the
// granular, human-scannable "process steps" the live dashboard renders — one row per
// concrete action (typing into DeepSeek, waiting for a reply, running a shell command),
// not one row per protocol message. Shared verbatim between the dashboard server (Node,
// via require) and the dashboard page itself (inlined into a <script> tag and run in the
// browser as each SSE event arrives) so the two never drift into rendering different
// stories about the same run.
const TOOL_LABELS = {
  SHELL: cmd => `Running shell command: ${cmd}`,
  READ_FILE: cmd => `Reading file: ${cmd}`,
  GREP: cmd => `Searching code (grep): ${cmd}`,
  FIND_FILE: cmd => `Finding file: ${cmd}`,
  LS: cmd => `Listing directory: ${cmd}`,
  SEARCH_WEB: cmd => `Searching the web: ${cmd}`,
  HTTP_GET: cmd => `Fetching URL: ${cmd}`,
  APPLY_PATCH: () => `Applying code patch`,
  WRITE_FILE: cmd => `Writing file: ${cmd}`,
  OPEN: cmd => `Opening: ${cmd}`,
};

function toolLabel(tool, params) {
  const cmd = (params && (params.command || params.path || params.query || params.url)) || JSON.stringify(params || {});
  const fn = TOOL_LABELS[tool];
  return fn ? fn(cmd) : `Running tool ${tool}: ${cmd}`;
}

function truncate(s, n) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function createStepState() {
  return { steps: [], open: {}, seq: 0, taskId: null };
}

// Mutates `state` in place: appends new steps, and fills in duration/status/detail on
// still-open steps (e.g. "typing" closes when the matching send_attempt arrives; a tool
// call closes when its result arrives). Mirrors a live terminal — nothing is ever removed,
// only appended or completed.
function reduceEvent(state, e) {
  if (e.taskId && !state.taskId) state.taskId = e.taskId;

  function push(step) {
    state.seq += 1;
    const full = { seq: state.seq, ...step };
    state.steps.push(full);
    return full;
  }

  if (e.type === 'timing' && e.phase === 'tab_setup') {
    push({
      category: 'system', role: 'system',
      label: 'Opening DeepSeek tabs (planner + executor)',
      detail: null, status: 'done', durationMs: e.elapsedMs,
    });
  } else if (e.type === 'timing' && e.phase === 'gather_context') {
    push({
      category: 'system', role: 'system',
      label: 'Reading project file list & memory',
      detail: null, status: 'done', durationMs: e.elapsedMs,
    });
  } else if (e.type === 'thinking_started') {
    const s = push({
      category: 'typing', role: e.role,
      label: `Typing & sending prompt to ${e.role} tab on DeepSeek`,
      detail: null, status: 'processing', durationMs: null,
    });
    state.open[`typing:${e.role}`] = s;
  } else if (e.type === 'timing' && e.phase === 'send_attempt') {
    const typingStep = state.open[`typing:${e.role}`];
    if (typingStep) {
      typingStep.status = 'done';
      typingStep.durationMs = 0;
      delete state.open[`typing:${e.role}`];
    }
    const d = e.diagnostics || {};
    const isTimeout = !!e.error;
    push({
      category: 'waiting_deepseek', role: e.role,
      label: isTimeout
        ? `Waiting for ${e.role} response on DeepSeek — attempt ${e.attempt}/${e.attempts} (timed out, retrying)`
        : `Waiting for ${e.role} to finish generating response (attempt ${e.attempt}/${e.attempts})`,
      detail: isTimeout ? e.error : (d.state ? `DeepSeek state: ${d.state}` : null),
      status: isTimeout ? 'timeout' : 'done',
      durationMs: e.elapsedMs,
    });
  } else if (e.type === 'timing' && e.phase === 'executor_primer') {
    push({
      category: 'system', role: 'executor',
      label: 'Priming executor tab with subtask instructions',
      detail: null, status: 'done', durationMs: e.elapsedMs,
    });
  } else if (e.type === 'planner_thinking') {
    push({
      category: 'planner', role: 'planner',
      label: 'Planner defined a new subtask',
      detail: truncate((e.text || '').replace(/^\[SUBTASK\]|\[\/SUBTASK\]$/g, '').trim(), 220),
      status: 'done', durationMs: null,
    });
  } else if (e.type === 'subtask_started') {
    push({
      category: 'planner', role: 'system',
      label: 'Handing subtask to executor tab',
      detail: truncate(e.subtask, 220),
      status: 'done', durationMs: null,
    });
  } else if (e.type === 'executor_code') {
    push({
      category: 'executor', role: 'executor',
      label: 'DeepSeek proposed an action',
      detail: e.summary, status: 'done', durationMs: null,
    });
  } else if (e.type === 'tool_call') {
    const s = push({
      category: 'tool', role: e.role,
      label: toolLabel(e.tool, e.params),
      detail: null, status: 'processing', durationMs: null,
    });
    state.open.tool = s;
  } else if (e.type === 'timing' && e.phase === 'tool_call') {
    const s = state.open.tool;
    if (s) s.durationMs = e.elapsedMs;
  } else if (e.type === 'tool_call_result') {
    const s = state.open.tool;
    const exitCode = e.result ? e.result.exitCode : null;
    const failed = (exitCode != null && exitCode !== 0) || !!e.error;
    if (s) {
      s.status = failed ? 'failed' : 'done';
      s.detail = failed
        ? `${e.error ? e.error : `exit ${exitCode}`} — ${truncate((e.result && e.result.stderr) || '', 200)}`
        : truncate((e.result && e.result.stdout) || '', 200) || null;
      delete state.open.tool;
    }
  } else if (e.type === 'task_completed') {
    push({
      category: 'system', role: 'system',
      label: 'Task completed',
      detail: truncate(e.summary, 220), status: 'done', durationMs: null,
    });
  } else if (e.type === 'task_error') {
    push({
      category: 'system', role: 'system',
      label: 'Task ended with an error',
      detail: truncate(e.message, 220), status: 'failed', durationMs: null,
    });
  } else if (e.type === 'tool_approval_required') {
    push({
      category: 'approval', role: e.role,
      label: 'Waiting for your approval',
      detail: truncate(e.description || e.tool || '', 220), status: 'processing', durationMs: null,
    });
    state.open.approval = state.steps[state.steps.length - 1];
  } else if (e.type === 'user_question_required') {
    push({
      category: 'approval', role: e.role,
      label: 'Agent asked a question — waiting for your answer',
      detail: truncate(e.question, 220), status: 'processing', durationMs: null,
    });
    state.open.approval = state.steps[state.steps.length - 1];
  }

  // any approval/question step resolves silently once another step from the same role
  // starts — DeepSeek/CLI don't emit an explicit "answered" event, so we close it out
  // opportunistically the moment forward progress resumes.
  if (state.open.approval && state.steps[state.steps.length - 1] !== state.open.approval) {
    state.open.approval.status = 'done';
    delete state.open.approval;
  }
}

function computeStats(steps) {
  return {
    totalSteps: steps.length,
    doneSteps: steps.filter(s => s.status === 'done').length,
    timeoutSteps: steps.filter(s => s.status === 'timeout').length,
    failedSteps: steps.filter(s => s.status === 'failed').length,
    processingSteps: steps.filter(s => s.status === 'processing').length,
    totalDurationMs: steps.reduce((sum, s) => sum + (s.durationMs || 0), 0),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createStepState, reduceEvent, computeStats, toolLabel, truncate };
}
