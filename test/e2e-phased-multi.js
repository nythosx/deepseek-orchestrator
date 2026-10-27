// Phase 7 e2e test: phased mode with 3 phases.
const h = require('./helpers');

(async () => {
  const restore = h.copyScenarioAsDefault('phased-multi');
  const dir = h.makeTempProject({ 'index.js': '// fixture\n' });
  try {
    await h.resetFakeBackend();
    const { events, timedOut } = await h.runCli(dir, 'Create three files');
    h.skipIfSetupNotReady(timedOut);

    const triage = events.find((e) => e.type === 'triage_decided');
    if (!triage) { console.error('FAIL: no triage_decided event'); process.exit(1); }
    if (triage.mode !== 'phased') { console.error('FAIL: expected mode=phased, got ' + triage.mode); process.exit(1); }

    const started = events.filter((e) => e.type === 'phase_started');
    const succeeded = events.filter((e) => e.type === 'phase_success');
    if (started.length !== 3) { console.error('FAIL: expected 3 phase_started, got ' + started.length); process.exit(1); }
    if (succeeded.length !== 3) { console.error('FAIL: expected 3 phase_success, got ' + succeeded.length); process.exit(1); }
    if (!events.some((e) => e.type === 'task_completed')) { console.error('FAIL: no task_completed event'); process.exit(1); }

    // All three files should exist on disk.
    const fs = require('fs');
    const path = require('path');
    for (const f of ['hello.txt', 'world.txt', 'verify.txt']) {
      if (!fs.existsSync(path.join(dir, f))) { console.error('FAIL: missing ' + f); process.exit(1); }
    }

    console.log('PASS: phased mode with 3 phases succeeded');
    process.exit(0);
  } finally {
    restore();
    h.cleanup(dir);
  }
})().catch((err) => { console.error(err); process.exit(1); });
