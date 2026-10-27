// Phase 7 e2e test: brain-tab rate-limit → recap-based migration.
//
// SKIP: same limitation as e2e-phased-rate-limit -- fake-backend can't simulate a 429 on
// the brain tab. The path this test would exercise (spec Addendum 2 Part K) is:
//   1. Brain 429s during a batch ping or triage turn
//   2. PhasedMigration.handleRateLimit fires with role='planner'
//   3. buildBrainRecap reconstructs state from .myclaudecode/phased/brain-log.jsonl
//   4. New brain tab gets the recap, replies [CONTINUE]
//   5. Loop resumes
// To verify manually against a real account, run a multi-phase task and force a 429 on the
// brain tab (e.g. by refreshing the tab mid-phase).
console.error('SKIP: brain-migration test requires fake-backend to simulate 429 on the brain (planner) tab.');
console.error('      To run this against a real rate limit, run a phased task against chat.deepseek.com and force the brain tab to 429.');
process.exit(77);
