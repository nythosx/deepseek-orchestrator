// Phase 7 e2e test: direct mode fails 3x, escalates to phased with 2 phases.
const h = require('./helpers');

(async () => {
  const restore = h.copyScenarioAsDefault('phased-escalation');
  const dir = h.makeTempProject({ 'index.js': '// fixture\n' });
  try {
    await h.resetFakeBackend();
    const { events, timedOut } = await h.runCli(dir, 'Trigger escalation');
    h.skipIfSetupNotReady(timedOut);

    const triages = events.filter((e) => e.type === 'triage_decided');
    if (triages.length < 2) { console.error('FAIL: expected 2 triage_decided events (initial + escalation), got ' + triages.length); process.exit(1); }
    if (triages[0].mode !== 'direct') { console.error('FAIL: first triage should be direct, got ' + triages[0].mode); process.exit(1); }
    if (triages[1].mode !== 'phased') { console.error('FAIL: escalation triage should be phased, got ' + triages[1].mode); process.exit(1); }

    if (!events.some((e) => e.type === 'direct_mode_escalated')) { console.error('FAIL: no direct_mode_escalated event'); process.exit(1); }
    if (!events.some((e) => e.type === 'task_completed')) { console.error('FAIL: no task_completed event'); process.exit(1); }

    console.log('PASS: escalation from direct to phased succeeded');
    process.exit(0);
  } finally {
    restore();
    h.cleanup(dir);
  }
})().catch((err) => { console.error(err); process.exit(1); });
