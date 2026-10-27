// Phase 7 e2e test: char-budget-triggered migration.
// Sets a very small charBudget in the temp project's config so any multi-phase run
// triggers migrate() on the second phase or later. Asserts at least one migrated event
// fires and the task still completes.
const h = require('./helpers');

(async () => {
  const restore = h.copyScenarioAsDefault('phased-multi');
  const dir = h.makeTempProject({ 'index.js': '// fixture\n' });
  h.patchConfig(dir, { charBudget: 800 });
  try {
    await h.resetFakeBackend();
    const { events, timedOut } = await h.runCli(dir, 'Trigger char-budget migration');
    h.skipIfSetupNotReady(timedOut);

    const migrated = events.filter((e) => e.type === 'migrated' || e.type === 'brain_migrated');
    if (migrated.length === 0) {
      console.error('FAIL: expected at least one migrated/brain_migrated event with charBudget=800, got none');
      process.exit(1);
    }
    if (!events.some((e) => e.type === 'task_completed')) { console.error('FAIL: no task_completed event'); process.exit(1); }

    console.log('PASS: char-budget migration fired ' + migrated.length + ' time(s) and task completed');
    process.exit(0);
  } finally {
    restore();
    h.cleanup(dir);
  }
})().catch((err) => { console.error(err); process.exit(1); });
