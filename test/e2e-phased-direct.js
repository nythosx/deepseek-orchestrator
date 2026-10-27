// Phase 7 e2e test: direct mode.
// Setup: fake-backend on :8080, extension loaded, native host installed.
// Exit: 0 PASS, 1 FAIL, 77 SKIP (setup not ready).
const h = require('./helpers');

(async () => {
  const restore = h.copyScenarioAsDefault('phased-direct');
  const dir = h.makeTempProject({ 'index.js': '// fixture\n' });
  try {
    await h.resetFakeBackend();
    const { events, timedOut } = await h.runCli(dir, 'Create hello.txt');
    h.skipIfSetupNotReady(timedOut);

    const triage = events.find((e) => e.type === 'triage_decided');
    if (!triage) { console.error('FAIL: no triage_decided event'); process.exit(1); }
    if (triage.mode !== 'direct') { console.error('FAIL: expected mode=direct, got ' + triage.mode); process.exit(1); }

    if (!events.some((e) => e.type === 'phase_success')) { console.error('FAIL: no phase_success event'); process.exit(1); }
    if (!events.some((e) => e.type === 'task_completed')) { console.error('FAIL: no task_completed event'); process.exit(1); }

    console.log('PASS: direct mode succeeded');
    process.exit(0);
  } finally {
    restore();
    h.cleanup(dir);
  }
})().catch((err) => { console.error(err); process.exit(1); });
