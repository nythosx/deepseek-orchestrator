// Shared helpers for the phased-mode e2e tests. Kept dependency-free -- only Node's
// standard library, so the test files have zero install overhead.
//
// The tests are NOT hermetic -- they need the full real stack running:
//   - fake-backend on http://localhost:8080 (with tabs.js pointed at it, not chat.deepseek.com)
//   - Chrome with the MyClaudeCode extension loaded and connected
//   - native-host installed (npm run install-host)
// If any of that isn't ready, runCli times out and the test exits 77 (SKIP) with a clear
// message. That's intentional: the tests are checkpoints, not CI gates that block on
// infrastructure the developer hasn't set up.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const CRAWLER = path.resolve(__dirname, '..');
const CLI = path.join(CRAWLER, 'cli', 'index.js');
const SCENARIOS = path.join(CRAWLER, 'fake-backend', 'scenarios');

// Copies fake-backend/scenarios/<name>.json to fake-backend/scenarios/default.json --
// because tabs.js is hardcoded to hit chat.deepseek.com without a `scenario=` URL param,
// the fake-backend falls back to its `default` scenario. Returns a restore function.
function copyScenarioAsDefault(name) {
  const src = path.join(SCENARIOS, name + '.json');
  const dst = path.join(SCENARIOS, 'default.json');
  if (!fs.existsSync(src)) throw new Error('missing scenario: ' + name);
  const backup = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : null;
  fs.copyFileSync(src, dst);
  return () => {
    if (backup !== null) fs.writeFileSync(dst, backup);
  };
}

function makeTempProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-e2e-'));
  for (const [name, content] of Object.entries(files || {})) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.mkdirSync(path.join(dir, '.myclaudecode'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.myclaudecode', 'config.json'),
    JSON.stringify({ phased: { enabled: true } }, null, 2)
  );
  return dir;
}

function patchConfig(dir, patch) {
  const p = path.join(dir, '.myclaudecode', 'config.json');
  const existing = JSON.parse(fs.readFileSync(p, 'utf8'));
  fs.writeFileSync(p, JSON.stringify({ ...existing, ...patch }, null, 2));
}

// Spawns the CLI against cwd. Keeps stdin as a pipe (never closed) so readline doesn't
// fire 'close' -> cleanupAndExit before the task runs -- see cli/index.js's readline
// wiring. The CLI exits naturally via advance() -> cleanupAndExit when the task
// completes/errors, or we SIGTERM it at timeout.
function runCli(cwd, task, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || 180000;
  const args = [CLI];
  args.push(opts.phased === false ? '--legacy' : '--phased');
  if (opts.filetrack) args.push('--filetrack');
  args.push('--approve-all', '--json', task);

  return new Promise((resolve) => {
    const child = spawn('node', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const events = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch (_) { /* non-JSON banner line */ }
      }
    });
    child.stderr.on('data', () => { /* swallow -- tests assert on structured events */ });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      resolve({ events, timedOut: true, exitCode: null });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ events, timedOut: false, exitCode: code });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ events, timedOut: false, exitCode: null, error: err.message });
    });
  });
}

function resetFakeBackend() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost', port: 8080, path: '/api/reset', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(true)); });
    req.on('error', () => resolve(false));
    req.write('{}');
    req.end();
  });
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
}

function skipIfSetupNotReady(timedOut) {
  if (!timedOut) return false;
  console.error(
    'SKIP: no terminal event within timeout.\n' +
    'Ensure:\n' +
    '  - fake-backend is running on http://localhost:8080 (npm run mock:server)\n' +
    '  - extension/lib/tabs.js CHAT_BASE_URL points at fake-backend (uncomment the localhost line)\n' +
    '  - Chrome has the MyClaudeCode extension loaded and connected\n' +
    '  - native-host installed (npm run install-host)'
  );
  process.exit(77);
}

module.exports = {
  CRAWLER, CLI, SCENARIOS,
  copyScenarioAsDefault, makeTempProject, patchConfig, runCli, resetFakeBackend,
  cleanup, skipIfSetupNotReady,
};
