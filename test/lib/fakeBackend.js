// Shared helper for e2e-*.js: spawns fake-backend/server.js and waits for it to actually
// be accepting requests before returning, instead of every test assuming something is
// already listening on :8080 and dying with ECONNREFUSED otherwise.
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const FAKE_BACKEND_URL = 'http://localhost:8080';

// Doubles as both a readiness probe and a turn-counter reset (the endpoint does both), so
// callers don't need a separate reset call once this returns true.
async function pingFakeBackend() {
  try {
    const res = await fetch(`${FAKE_BACKEND_URL}/api/reset`, { method: 'POST' });
    return res.ok;
  } catch (_) {
    return false;
  }
}

async function waitUntil(checkFn, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkFn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// Returns the spawned child process (caller must kill it when done), or null if an
// existing server on :8080 was reused instead (in which case it's left running — e.g. a
// dev instance the user started manually for iterating on scenarios).
async function ensureFakeBackend() {
  if (await pingFakeBackend()) {
    console.log('[harness] fake-backend already running on :8080 — reusing it.');
    return null;
  }
  console.log('[harness] starting fake-backend...');
  const proc = spawn('node', [path.join(REPO_ROOT, 'fake-backend', 'server.js')], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => process.stdout.write(`[fake-backend] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[fake-backend:err] ${d}`));
  const up = await waitUntil(pingFakeBackend, 10000);
  if (!up) {
    proc.kill();
    throw new Error('fake-backend did not become ready on :8080 within 10s');
  }
  console.log('[harness] fake-backend is up.');
  return proc;
}

// Runs `testFn` with the fake-backend guaranteed up, tearing down only the instance this
// call itself started. Wraps the "don't skip cleanup on process.exit()" footgun for callers.
async function withFakeBackend(testFn) {
  const fakeBackend = await ensureFakeBackend();
  try {
    await testFn();
  } finally {
    if (fakeBackend) fakeBackend.kill();
  }
}

module.exports = { ensureFakeBackend, pingFakeBackend, withFakeBackend };
