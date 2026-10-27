// Phase 7 e2e test: filetrack detects externally-created files.
// Hand-crafts an empty baseline snapshot, then runs the CLI with --filetrack. Since the
// snapshot is empty and a.txt exists on disk, filetrack should log a.txt as "created" to
// .myclaudecode/filetrack/changes.jsonl.
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

(async () => {
  const restore = h.copyScenarioAsDefault('phased-direct');
  const dir = h.makeTempProject({
    'index.js': '// fixture\n',
    'a.txt': 'preexisting\n',
  });
  // Hand-craft empty baseline snapshot so a.txt (already on disk) is seen as "created".
  fs.mkdirSync(path.join(dir, '.myclaudecode', 'filetrack'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.myclaudecode', 'filetrack', 'snapshot.json'),
    JSON.stringify({ version: 1, takenAt: 0, entries: {}, lastLoggedPath: null, lastLoggedAt: 0 }, null, 2)
  );
  try {
    await h.resetFakeBackend();
    const { timedOut } = await h.runCli(dir, 'Noop with filetrack', { filetrack: true });
    h.skipIfSetupNotReady(timedOut);

    const changesPath = path.join(dir, '.myclaudecode', 'filetrack', 'changes.jsonl');
    if (!fs.existsSync(changesPath)) { console.error('FAIL: changes.jsonl not created'); process.exit(1); }
    const changes = fs.readFileSync(changesPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const aTxt = changes.find((c) => c.path === 'a.txt');
    if (!aTxt) { console.error('FAIL: expected a.txt in changes.jsonl, got: ' + JSON.stringify(changes)); process.exit(1); }
    if (aTxt.action !== 'created') { console.error('FAIL: expected action=created for a.txt, got ' + aTxt.action); process.exit(1); }

    console.log('PASS: filetrack detected a.txt as created');
    process.exit(0);
  } finally {
    restore();
    h.cleanup(dir);
  }
})().catch((err) => { console.error(err); process.exit(1); });
