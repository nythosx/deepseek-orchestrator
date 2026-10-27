// Phase 7 e2e test: rate-limit backoff then migration.
//
// SKIP: fake-backend does not currently simulate a 429/503 response, so the network-layer
// rate-limit detection path can't be triggered deterministically. This test exists as a
// placeholder; to make it runnable, patch fake-backend's /api/simulate to return a 429
// after N turns for a specific scenario name, or run against the real chat.deepseek.com
// with a real rate-limited account.
console.error('SKIP: rate-limit test requires fake-backend to simulate 429/503 responses (not currently implemented).');
console.error('      To run this against a real rate limit, run a phased task against chat.deepseek.com with a rate-limited account.');
process.exit(77);
