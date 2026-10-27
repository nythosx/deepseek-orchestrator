// Escalation prompt (spec Part A.8). Called by PhasedBrainLayer.escalate when direct mode
// exhausts its apyMaxFixAttempts. Brain decides [DIRECT] (corrected brief) or [PHASED].
const buildEscalationPrompt = (function () {
  return function buildEscalationPrompt(opts) {
    const notice = (typeof TIMESTAMP_NOTICE !== 'undefined') ? TIMESTAMP_NOTICE : '';
    const filesList = Array.isArray(opts.filesTouched) && opts.filesTouched.length
      ? opts.filesTouched.join('\n')
      : '(none)';
    return (
      'Direct-mode ' + (opts.filename || 'a.py') + ' failed all ' + (opts.maxAttempts || 3) + ' attempts. Re-triage this task.\n\n' +
      notice + '\n\n' +
      '=== ORIGINAL TASK ===\n' + (opts.taskDescription || '') + '\n\n' +
      '=== FINAL TRACEBACK ===\n' + (opts.traceback || '(none)') + '\n\n' +
      '=== FILES THE FAILED DIRECT a.py ALREADY TOUCHED ===\n' + filesList + '\n\n' +
      '=== CURRENT FILE STATE (manifest + relevant contents) ===\n' + (opts.bundle || '(unavailable)') + '\n\n' +
      'Decide:\n' +
      '- If the traceback reveals a fixable bug and the task still fits in ~10,000\n' +
      '  LOC, reply [DIRECT] with a corrected [BRIEF]. The orchestrator will retry\n' +
      '  direct mode with a fresh attempt budget.\n' +
      '- If the task genuinely needs phasing (either because the LOC estimate was\n' +
      '  wrong, or because the direct attempt got stuck on a complexity that needs\n' +
      '  decomposition), reply [PHASED] with a phase plan. Any file listed in "FILES\n' +
      '  THE FAILED DIRECT a.py ALREADY TOUCHED" must be assigned to phase 1 or 2 --\n' +
      '  later phases must BUILD ON that work, not re-do it.\n\n' +
      'You do NOT write code. You only decide shape and produce a brief or phase plan.\n' +
      '- BREVITY: no preamble. Output ONLY the [DIRECT]/[PHASED] block.\n'
    );
  };
})();
