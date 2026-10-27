// Orchestrator-side wrapper for the filetrack native module (see native-host/lib/filetrack.js
// for the implementation, and spec 4.4 for the design). Called from:
//   - brainLayer.triage (before the triage prompt)
//   - brainLayer.ping (before the batch summary)
//   - brainLayer.escalate (before re-triage)
//   - (task end -- snapshot) -- deferred to Phase 7 or a small follow-up, since it would
//                              require touching runner.js's finally block.
// preApyCheck is implemented here for future use (spec 4.4's race-condition guard); the
// trigger point is deferred for the same reason (would need a runner.js edit).
const PhasedFiletrack = (() => {
  function enabledFor(session) {
    if (!session) return false;
    if (session.filetrackOverride === true) return true;
    if (session.filetrackOverride === false) return false;
    return !!(session.filetrackConfig && session.filetrackConfig.enabled);
  }

  async function _scan(session, mode) {
    const bulkThreshold =
      (session.filetrackConfig && session.filetrackConfig.bulkThreshold) || 100;
    return NativeBridge.execTool(session.taskId, TOOLS.FILETRACK_SCAN, {
      mode: mode || 'check',
      bulkThreshold,
    });
  }

  async function check(session) {
    if (!enabledFor(session)) return { changes: [], disabled: true };
    try {
      return await _scan(session, 'check');
    } catch (err) {
      console.warn('[PhasedFiletrack] check failed:', err.message);
      return { changes: [], error: err.message };
    }
  }

  async function snapshot(session) {
    if (!enabledFor(session)) return { disabled: true };
    try {
      return await _scan(session, 'snapshot');
    } catch (err) {
      console.warn('[PhasedFiletrack] snapshot failed:', err.message);
      return { error: err.message };
    }
  }

  // Returns a formatted text summary suitable for embedding in a brain prompt, or empty
  // string if there are no changes (caller omits the section entirely in that case).
  function summarize(result) {
    if (!result || result.disabled) return '';
    if (result.bulk) {
      return 'Bulk change detected: ' + (result.count || 0) + ' files (likely git checkout / pull / branch switch).';
    }
    const changes = result.changes || [];
    if (!changes.length) return '';
    const lines = changes.slice(0, 20).map((c) => '- ' + c.path + ' (' + c.action + ')');
    if (changes.length > 20) {
      lines.push('… and ' + (changes.length - 20) + ' more');
    }
    return lines.join('\n');
  }

  async function summarizeForPrompt(session) {
    if (!enabledFor(session)) return '';
    try {
      const result = await check(session);
      return summarize(result);
    } catch (_) {
      return '';
    }
  }

  // Pre-a.py race-condition check (spec 4.4): right before running a.py, if any file the
  // current phase declares it owns changed externally since triage, log a high-severity
  // attention item. Returns the list of conflicting changes (empty if none).
  async function preApyCheck(session, phase) {
    if (!enabledFor(session)) return [];
    if (!phase || !Array.isArray(phase.files) || !phase.files.length) return [];
    try {
      const result = await check(session);
      const owned = new Set(phase.files);
      const conflicts = (result.changes || []).filter((c) => owned.has(c.path));
      if (conflicts.length) {
        if (typeof PhasedLogStore !== 'undefined' && PhasedLogStore.appendAttention) {
          await PhasedLogStore.appendAttention(session, {
            phase: phase.name,
            kind: 'phase_file_changed_externally',
            severity: 'high',
            detail: 'Files declared by this phase were modified externally since triage: ' + conflicts.map((c) => c.path + '(' + c.action + ')').join(', '),
          }).catch(() => {});
        }
      }
      return conflicts;
    } catch (_) {
      return [];
    }
  }

  return { enabledFor, check, snapshot, summarize, summarizeForPrompt, preApyCheck };
})();
