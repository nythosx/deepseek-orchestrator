// Coder prompt surface, split into two pieces (Phase 18):
//   buildApyCoderPrimerBase()  -- base rules, sent ONCE per coder tab at warmup
//   buildApyTaskPrompt(opts)   -- per-task filename/mode/scope/files, sent per unit of work
//   buildApyFixPrompt(opts)    -- retry with traceback
// APY_CODER_PROMPT is exported as a constant so migration.js can reuse the base text.
//
// Phase 22 (2026-10-25): strengthened the no-comments rule. DeepSeek repeatedly
// emitted a.py scripts with # comments despite the previous instruction being
// present. Comment text costs tokens and, worse, the script is echoed back in
// future prompts -- DeepSeek sometimes mistakes those comments for real
// instructions and re-executes them. Zero comments, not "avoid comments".

const APY_CODER_PROMPT =
  'You are a coding agent producing ONE Python script that applies a specific change. ' +
  'You output EXACTLY ONE ```python code block. No prose before or after.\n\n' +
  'ZERO-COMMENTS RULE (non-negotiable, strictest rule in this prompt):\n' +
  '- NO COMMENTS of any kind. Not `#`, not `//`, not `/* */`, not docstrings,\n' +
  '  not inline, not block, not TODO markers, not type-ignore pragmas, nothing.\n' +
  '- If you feel the urge to write a comment, use a better variable or function\n' +
  '  name instead. The code should be self-documenting or it should be fixed.\n' +
  '- Reason (do not repeat this back): comments from a.py get echoed into future\n' +
  '  task prompts, and previous DeepSeek turns have mistaken comment text for\n' +
  '  actual instructions. Zero comments prevents that failure mode.\n\n' +
  'Other rules:\n' +
  '- Idempotent -- safe to run twice.\n' +
  '- No backup logic. The orchestrator + git are the safety net.\n' +
  '- Do not add defensive try/except for every edge case -- the traceback loop\n' +
  '  and downstream reviewer catch what breaks.\n' +
  '- Do not `git commit`, `git add`, or `git push`. The user does that manually.\n' +
  '- Before running the phase\'s tests, print on its own line:\n' +
  '  __PHASE_WROTE__ <comma,separated,paths you wrote or edited>\n' +
  '- After all tests pass, print on its own line:\n' +
  '  __PHASE_SUCCESS__\n' +
  '- If any test fails, let the exception propagate -- do not catch it. The\n' +
  '  orchestrator reads stderr for the traceback.\n\n' +
  'Output format: one ```python code block. Nothing else.\n' +
  '- BREVITY: no prose, no summary. One code block, nothing else.\n' +
  '\n' +
  'A.PY WORKING DIRECTORY: your script always runs with cwd set to the project\n' +
  'root. If you need to touch files OUTSIDE the project, use absolute paths in\n' +
  'Python: open(r"C:\\other\\path") or Path("/c/other/path"). Do not rely on\n' +
  'os.chdir() to navigate -- a.py always starts at project root.\n' +
  '\n' +
  'PER-PHASE LOC LIMIT: each task prompt you receive targets ~1,500-2,000\n' +
  'lines of code change. If the scope you are given clearly exceeds ~2,000\n' +
  'LOC (e.g. multiple thousand-line rewrites in one shot), say so in one\n' +
  'line before your code block -- the orchestrator will flag it and the\n' +
  'brain will re-scope into a smaller phase. Do NOT silently produce a\n' +
  'massive script; a single a.py that changes more than ~2,000 LOC means\n' +
  'the phase should have been split.\n';

const buildApyCoderPrimerBase = (function () {
  return function buildApyCoderPrimerBase() {
    const notice = (typeof TIMESTAMP_NOTICE !== 'undefined') ? TIMESTAMP_NOTICE : '';
    return notice + '\n\n' + APY_CODER_PROMPT;
  };
})();

const buildApyTaskPrompt = (function () {
  return function buildApyTaskPrompt(opts) {
    const mode = opts.mode || 'phased';
    const index = opts.index || 1;
    const total = opts.total || 1;
    const modeLine = mode === 'direct'
      ? 'direct (phase 1 of 1)'
      : 'phased (phase ' + index + ' of ' + total + ')';
    const priorSection = opts.priorPhaseOutput
      ? '=== PRIOR PHASE OUTPUT ===\n' + opts.priorPhaseOutput + '\n\n'
      : '';
    const refSection = opts.referenceFiles
      ? '=== REFERENCE FILES (patterns to follow, do not modify) ===\n' + opts.referenceFiles + '\n\n'
      : '';
    return (
      '=== FILENAME ===\n' + (opts.filename || '(unnamed)') + '\n\n' +
      '=== MODE ===\n' + modeLine + '\n\n' +
      '=== SCOPE ===\n' + (opts.scope || '(no scope provided)') + '\n\n' +
      '=== RELEVANT FILE CONTENTS ===\n' + (opts.filesContents || '(no files provided)') + '\n\n' +
      refSection +
      priorSection +
      'Now output the a.py script for THIS task in one ```python code block. Nothing else.\n'
    );
  };
})();

const buildApyFixPrompt = (function () {
  return function buildApyFixPrompt(opts) {
    const notice = (typeof TIMESTAMP_NOTICE !== 'undefined') ? TIMESTAMP_NOTICE : '';
    return (
      'Running ' + (opts.filename || 'a.py') + ' failed (attempt ' + (opts.attempt || 1) +
      '/' + (opts.maxAttempts || 3) + ').\n\n' +
      notice + '\n\n' +
      'Current ' + (opts.filename || 'a.py') + ':\n' +
      '```python\n' + (opts.currentApy || '') + '\n```\n\n' +
      'Traceback (stderr tail):\n' +
      '```\n' + (opts.traceback || '(none)') + '\n```\n\n' +
      'Fix ' + (opts.filename || 'a.py') + ' and output the whole file again in one ```python code block.\n' +
      'ZERO COMMENTS in the fixed script. Idempotent. Same protocol rules as before\n' +
      '(__PHASE_WROTE__ before tests, __PHASE_SUCCESS__ after tests pass).\n' +
      '- BREVITY: one code block, nothing else.\n'
    );
  };
})();
