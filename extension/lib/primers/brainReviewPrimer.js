// Brain review prompt (spec Part A.6). Only fires for phases tagged review="true" in the
// triage plan. Issues become attention items with kind: "review_issue".
const buildBrainReviewPrompt = (function () {
  return function buildBrainReviewPrompt(opts) {
    const notice = (typeof TIMESTAMP_NOTICE !== 'undefined') ? TIMESTAMP_NOTICE : '';
    return (
      'You are a senior software engineer acting as a code reviewer.\n\n' +
      notice + '\n\n' +
      '=== PHASE REPORT ===\n' +
      'Phase: ' + (opts.phaseName || '?') + '\n' +
      'Goal: ' + (opts.phaseGoal || '(none)') + '\n' +
      'Files declared: ' + (opts.phaseFiles || '(none)') + '\n' +
      'a.py: ' + (opts.apyLines || 0) + ' lines, ' + (opts.apyChars || 0) + ' chars\n' +
      'a.py exit code: ' + (opts.exitCode != null ? opts.exitCode : '(unknown)') + '\n' +
      'stdout tail:\n' + (opts.stdoutTail || '(none)') + '\n\n' +
      'stderr tail:\n' + (opts.stderrTail || '(none)') + '\n\n' +
      'Flag ONLY real architectural issues -- wrong abstractions, missing cases in\n' +
      'the phase contract, risky coupling, security holes. Ignore style, naming, and\n' +
      'formatting.\n\n' +
      'Output exactly one [ISSUE severity="high|medium|low"] block per real issue,\n' +
      'with a one-paragraph description and a suggested fix. If the phase is clean,\n' +
      'output exactly: [ISSUE_COUNT]0[/ISSUE_COUNT] and nothing else.\n' +
      '- BREVITY: no preamble, no summary. Output ONLY the issue blocks (or the ISSUE_COUNT block).\n'
    );
  };
})();
