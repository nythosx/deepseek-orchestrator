// Phase 7 e2e test: Continue-button post-click grace period (Addendum 2 Part I Bug 1).
//
// SKIP: fake-backend does not render a Continue button mid-response, so the truncation
// path can't be exercised deterministically. The grace period itself (continueJustClickedAt
// + 8-second requiredStableMs) is a pure content.js primitive; verify manually by:
//   1. Running a task whose response is long enough that DeepSeek truncates it
//   2. Watching that the response finishes (not truncated at the pre-Continue point)
//   3. Checking .myclaudecode/logs/*.log for "Continue button detected, clicking"
//      followed by a normal successful turn (no timeout)
console.error('SKIP: continue-button test requires fake-backend to simulate a truncated response with a Continue button.');
console.error('      To verify manually, run a real task whose response triggers DeepSeek\'s Continue button.');
process.exit(77);
