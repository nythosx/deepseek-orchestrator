// Batch-ping decision + summary builder (spec section 4.3). Called between phases by
// PhasedRunner.runPhasedMode (via PhasedBrainLayer.ping when shouldPing returns true).
const PhasedBrainPinger = (() => {
  const MAX_BATCH_SUMMARY_CHARS = 5000;

  // Spec 4.3 batching rules. Caller is expected to call this after PHASE_SUCCESS, with
  // session.successStreak already incremented by the runner.
  function shouldPing(session) {
    const config = session.phasedConfig || {};
    const perPing = config.phasesPerBrainPing || 3;
    const items = session.attentionQueue || [];
    // Critical always pings, regardless of streak.
    if (items.some((a) => a.severity === 'critical')) return true;
    // High pings only if the streak is 0 (we're in a degraded state).
    if (items.some((a) => a.severity === 'high') && session.successStreak === 0) return true;
    // Regular batch cadence.
    if (session.successStreak >= perPing) return true;
    return false;
  }

  function fmtPhaseList(plan, currentIndex) {
    if (!plan || !plan.length) return '(no phase plan set)';
    const lines = [];
    for (let i = 0; i < plan.length; i++) {
      const ph = plan[i];
      if (i < currentIndex) lines.push('✓ phase ' + (i + 1) + ' (' + ph.name + ')');
      else if (i === currentIndex) lines.push('▶ phase ' + (i + 1) + ' (' + ph.name + ') — IN PROGRESS');
      else lines.push('  phase ' + (i + 1) + ' (' + ph.name + ') — pending');
    }
    return lines.join('\n');
  }

  function fmtLogTail(entries) {
    if (!entries || !entries.length) return '(no new log entries since last ping)';
    return entries
      .map((e) => {
        const dur = e.durationMs != null ? e.durationMs + 'ms' : '?';
        const files = (e.filesTouched || []).join(',') || 'none';
        return '[' + (e.phase || '?') + ' attempt ' + (e.attempt || '?') + '] exit=' + e.exitCode + ' marker=' + e.successMarker + ' (' + dur + ') files=[' + files + ']';
      })
      .join('\n');
  }

  function fmtAttentionTail(items) {
    if (!items || !items.length) return '(no new attention items since last ping)';
    return items
      .map((a) => '[' + (a.severity || '?') + '] ' + (a.kind || '?') + ': ' + (a.detail || '').slice(0, 300))
      .join('\n');
  }

  async function buildBatchSummary(session) {
    const parts = [];
    const push = (label, body) => parts.push('=== ' + label + ' ===\n' + (body || '(none)'));

    push('TASK', session.taskDescription || '');

    // Phase plan progress
    push('PHASE PLAN', fmtPhaseList(session.phasePlan || [], session.currentPhaseIndex || 0));

    // Log entries since last ping. Use cached entries + count tracking; if the log isn't
    // available (e.g. tests running without a real native host), degrade gracefully.
    session.lastPingedLogCount = session.lastPingedLogCount || 0;
    let logEntries = [];
    try {
      const all = await PhasedLogStore.readLog(session);
      logEntries = all.slice(session.lastPingedLogCount);
      session._pendingLogCount = all.length;
    } catch (_) {}
    let logTail = fmtLogTail(logEntries).slice(0, 3000);
    push('LOG SINCE LAST PING', logTail);

    // Attention items since last ping
    session.lastPingedAttentionCount = session.lastPingedAttentionCount || 0;
    let attentionEntries = [];
    try {
      const all = await PhasedLogStore.readAttention(session);
      attentionEntries = all.slice(session.lastPingedAttentionCount);
      session._pendingAttentionCount = all.length;
    } catch (_) {}
    let attentionTail = fmtAttentionTail(attentionEntries).slice(0, 1500);
    push('ATTENTION ITEMS SINCE LAST PING', attentionTail);

    // External changes (filetrack). Skipped silently if not available.
    let externalChanges = '';
    if (typeof PhasedFiletrack !== 'undefined' && typeof PhasedFiletrack.summarizeForPrompt === 'function') {
      try {
        externalChanges = await PhasedFiletrack.summarizeForPrompt(session);
      } catch (_) {}
    }
    if (externalChanges) {
      push('EXTERNAL CHANGES SINCE LAST PING', externalChanges.slice(0, 500));
    }

    const summary = parts.join('\n\n') + '\n';
    if (summary.length > MAX_BATCH_SUMMARY_CHARS) {
      return summary.slice(0, MAX_BATCH_SUMMARY_CHARS) + '\n…(batch summary truncated at ' + MAX_BATCH_SUMMARY_CHARS + ' chars)';
    }
    return summary;
  }

  // Called after a successful ping to reset "since last ping" counters.
  function markPinged(session) {
    if (session._pendingLogCount != null) {
      session.lastPingedLogCount = session._pendingLogCount;
      session._pendingLogCount = null;
    }
    if (session._pendingAttentionCount != null) {
      session.lastPingedAttentionCount = session._pendingAttentionCount;
      session._pendingAttentionCount = null;
    }
    session.successStreak = 0;
  }

  return { shouldPing, buildBatchSummary, markPinged };
})();
