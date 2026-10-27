// Turns the raw --json event stream (see shared/protocol.js CLI_MESSAGE_TYPES) into the
// granular, human-scannable "process steps" the live dashboard renders — one row per
// concrete action (typing into DeepSeek, waiting for a reply, running a shell command),
// not one row per protocol message. Shared verbatim between the dashboard server (Node,
// via require) and the dashboard page itself (inlined into a <script> tag and run in the
// browser as each SSE event arrives) so the two never drift into rendering different
// stories about the same run.
//
// Phase 6 additions: phased-mode events (triage_decided, phase_started/success/failed,
// direct_mode_escalated, attention_ping, migrated/brain_migrated, bundle_too_large,
// exclusion_round_started/done, rate_limit_detected) plus the FILETRACK_SCAN tool label.
// All are additive else-if branches — legacy events flow through unchanged.
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
  // Internal-only — the orchestrator calls this directly via NativeBridge, never via a
  // model-emitted tool call, so this label is mostly for completeness/future-proofing.
  FILETRACK_SCAN: () => `Scanning project for external changes`,
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
// call closes when its result arrives; a phase closes when PHASE_SUCCESS/PHASE_FAILED
// arrives). Mirrors a live terminal — nothing is ever removed, only appended or completed.
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
  } else if (e.type === 'triage_decided') {
    const modeLabel = e.mode === 'direct' ? 'DIRECT' : e.mode === 'phased' ? 'PHASED' : String(e.mode || '?').toUpperCase();
    const suffix = e.note === 'escalation_to_phased'
      ? ' (from escalation)'
      : e.note === 'escalation_retry'
        ? ' (retry after escalation)'
        : '';
    push({
      category: 'system', role: 'system',
      label: `Triaged task: ${modeLabel}, est. ${e.estimate ?? '?'} LOC${suffix}`,
      detail: null, status: 'done', durationMs: null,
    });
  } else if (e.type === 'direct_mode_escalated') {
    const files = Array.isArray(e.filesTouched) && e.filesTouched.length
      ? ` (touched: ${e.filesTouched.slice(0, 5).join(', ')}${e.filesTouched.length > 5 ? ', …' : ''})`
      : '';
    push({
      category: 'system', role: 'system',
      label: `Direct mode failed — escalating to phased${files}`,
      detail: truncate(e.traceback || e.reason || '', 200),
      status: 'failed', durationMs: null,
    });
  } else if (e.type === 'phase_started') {
    const s = push({
      category: 'phased', role: 'executor',
      label: `Phase ${e.index ?? '?'}/${e.total ?? '?'}: ${e.phase || '?'}`,
      detail: null, status: 'processing', durationMs: null,
    });
    state.open[`phase:${e.phase || '?'}`] = s;
  } else if (e.type === 'phase_success') {
    const s = state.open[`phase:${e.phase || '?'}`];
    const filesLine = Array.isArray(e.filesTouched) && e.filesTouched.length
      ? `wrote: ${e.filesTouched.join(', ')}`
      : null;
    if (s) {
      s.status = 'done';
      s.durationMs = e.durationMs ?? null;
      s.detail = filesLine;
      delete state.open[`phase:${e.phase || '?'}`];
    } else {
      // Success arrived without a matching phase_started (shouldn't happen, but defensive).
      push({
        category: 'phased', role: 'executor',
        label: `Phase complete: ${e.phase || '?'}`,
        detail: filesLine, status: 'done', durationMs: e.durationMs ?? null,
      });
    }
  } else if (e.type === 'phase_failed') {
    const s = state.open[`phase:${e.phase || '?'}`];
    const detail = `after ${e.attempts ?? '?'} attempt(s)` + (e.traceback ? ` — ${truncate(e.traceback, 160)}` : '');
    if (s) {
      s.status = 'failed';
      s.detail = detail;
      delete state.open[`phase:${e.phase || '?'}`];
    } else {
      push({
        category: 'phased', role: 'executor',
        label: `Phase failed: ${e.phase || '?'}`,
        detail, status: 'failed', durationMs: null,
      });
    }
  } else if (e.type === 'attention_ping') {
    const item = e.item || {};
    const severity = item.severity || 'medium';
    // Visual mapping: critical -> failed (red), high -> timeout (yellow), medium/low -> done
    // (green is a bit off for "medium attention" but the reducer's status enum is fixed;
    // the severity badge in the label conveys the actual weight).
    const status = severity === 'critical' ? 'failed' : severity === 'high' ? 'timeout' : 'done';
    push({
      category: 'attention', role: 'system',
      label: `[${severity}] ${item.kind || 'attention'}`,
      detail: truncate(item.detail || '', 220),
      status, durationMs: null,
    });
  } else if (e.type === 'migrated' || e.type === 'brain_migrated') {
    const roleLabel = e.role === 'planner' ? 'brain' : (e.role === 'executor' ? 'coder' : (e.role || '?'));
    push({
      category: 'system', role: 'system',
      label: `Migrated ${roleLabel} tab (${e.reason || '?'}, ${e.mode || '?'} bundle, ${e.bundleChars ?? '?'} chars)`,
      detail: null, status: 'done', durationMs: null,
    });
  } else if (e.type === 'bundle_too_large') {
    push({
      category: 'system', role: 'system',
      label: `Bundle too large: ${e.chars ?? '?'} chars (threshold ${e.threshold ?? '?'})`,
      detail: 'Running exclusion loop to shrink the bundle before migration.',
      status: 'timeout', durationMs: null,
    });
  } else if (e.type === 'exclusion_round_started') {
    const s = push({
      category: 'system', role: 'system',
      label: `Exclusion round ${e.round ?? '?'}`,
      detail: null, status: 'processing', durationMs: null,
    });
    state.open[`exclusion:${e.round ?? '?'}`] = s;
  } else if (e.type === 'exclusion_round_done') {
    const s = state.open[`exclusion:${e.round ?? '?'}`];
    const detail = `now ${e.chars ?? '?'} chars` + (e.stillTooLarge ? ' — still too large' : '');
    if (s) {
      s.status = e.stillTooLarge ? 'timeout' : 'done';
      s.detail = detail;
      delete state.open[`exclusion:${e.round ?? '?'}`];
    } else {
      push({
        category: 'system', role: 'system',
        label: `Exclusion round ${e.round ?? '?'} done`,
        detail, status: e.stillTooLarge ? 'timeout' : 'done', durationMs: null,
      });
    }
  } else if (e.type === 'rate_limit_detected') {
    push({
      category: 'system', role: 'system',
      label: `Rate limit detected on ${e.role === 'planner' ? 'brain' : (e.role || '?')} tab`,
      detail: e.retryAt
        ? `Retrying on the same tab at ${new Date(e.retryAt).toLocaleTimeString()} (attempt ${e.attempt}/${e.maxRetries}).`
        : 'Backing off before migration.',
      status: 'timeout', durationMs: null,
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

  // Close out any still-open phase cards when the task itself ends. In normal flow this
  // is a no-op — PHASE_SUCCESS/PHASE_FAILED always fire per phase — but it prevents a
  // "processing" card from lingering forever if the task errors mid-phase.
  if (e.type === 'task_completed' || e.type === 'task_error') {
    const finalStatus = e.type === 'task_completed' ? 'done' : 'failed';
    for (const key of Object.keys(state.open)) {
      if (key.startsWith('phase:') || key.startsWith('exclusion:')) {
        const s = state.open[key];
        if (s && s.status === 'processing') s.status = finalStatus;
        delete state.open[key];
      }
    }
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
