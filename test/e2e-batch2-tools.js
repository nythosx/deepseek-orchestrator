#!/usr/bin/env node
// Unit-level checks for the second batch of report-driven features (recommendations 4-14):
// incremental gate config normalization is covered indirectly via orchestrator behavior
// tests elsewhere; this file covers the native-host/parser-level pieces directly —
// pattern-based permission rules, READ_FILE pagination, working-tree hashing, the
// persistent task list, rule-file loading, and declarative external tools/CALL_ parsing.
// No browser or fake-backend needed. Usage: node test/e2e-batch2-tools.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const tools = require('../native-host/lib/tools');

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function loadToolCallParser() {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'extension/lib/toolCalls.js'), 'utf8');
  return new Function(`${src}\nreturn ToolCallParser;`)();
}

function testPermissionRules() {
  const perms = {
    rules: {
      allow: ['SHELL(npm test)', 'SHELL(npm run *)'],
      ask: ['SHELL(git push*)'],
      deny: ['SHELL(rm -rf *)'],
    },
  };
  assert(tools.evaluatePermission(perms, 'SHELL', 'npm test').verdict === 'allow', 'npm test should be allowed');
  assert(tools.evaluatePermission(perms, 'SHELL', 'npm run build').verdict === 'allow', 'npm run * should be allowed');
  assert(tools.evaluatePermission(perms, 'SHELL', 'git push origin main').verdict === 'ask', 'git push* should ask');
  assert(tools.evaluatePermission(perms, 'SHELL', 'rm -rf /').verdict === 'deny', 'rm -rf * should deny');
  assert(tools.evaluatePermission(perms, 'SHELL', 'ls -la').verdict === 'allow', 'unmatched command should default allow');

  const compoundDeny = tools.evaluatePermission(perms, 'SHELL', 'npm test && rm -rf /');
  assert(compoundDeny.verdict === 'deny', 'a denied subcommand anywhere in a chain should deny the whole thing');

  const compoundAsk = tools.evaluatePermission(perms, 'SHELL', 'npm test && git push origin main');
  assert(compoundAsk.verdict === 'ask', 'ask should win over an allowed subcommand in the same chain');

  // Legacy fallback — no `rules` configured.
  const legacy = tools.evaluatePermission({ dangerousCommands: ['sudo'] }, 'SHELL', 'sudo rm x');
  assert(legacy.verdict === 'ask' && legacy.matched === 'sudo', 'legacy dangerousCommands fallback should still work');
  const legacySafe = tools.evaluatePermission({ dangerousCommands: ['sudo'] }, 'SHELL', 'ls');
  assert(legacySafe.verdict === 'allow', 'legacy fallback: unmatched command should be allowed');

  console.log('[harness] pattern-based permission rules: allow/ask/deny, compound splitting, and legacy fallback all behave correctly');
}

function testReadFilePagination(projectRoot) {
  const lines = [];
  for (let i = 1; i <= 3000; i++) lines.push(`line ${i}`);
  fs.writeFileSync(path.join(projectRoot, 'big.txt'), lines.join('\n'), 'utf8');

  const auto = tools.readFile(projectRoot, { path: 'big.txt' });
  assert(/PARTIAL/.test(auto), 'a file over the default line cap should auto-paginate with a PARTIAL marker');
  assert(/line 1\b/.test(auto) && !/line 2001\b/.test(auto), 'auto-pagination should show the first N lines only');

  const page2 = tools.readFile(projectRoot, { path: 'big.txt', offset: 2001, limit: 500 });
  assert(/\(lines 2001-2500 of 3000\)/.test(page2), `expected an explicit page header, got: ${page2.slice(0, 60)}`);
  assert(/line 2001\b/.test(page2) && !/line 2501\b/.test(page2), 'explicit page should show exactly the requested range');

  fs.writeFileSync(path.join(projectRoot, 'small.txt'), 'hello\nworld\n', 'utf8');
  const small = tools.readFile(projectRoot, { path: 'small.txt' });
  assert(small === 'hello\nworld\n', 'a small file with no explicit range should return exactly the raw content, unwrapped');

  console.log('[harness] READ_FILE pagination: auto-truncation, explicit ranges, and small-file passthrough all behave correctly');
}

function testHashWorkingTree(projectRoot) {
  const h1 = tools.hashWorkingTree(projectRoot);
  fs.writeFileSync(path.join(projectRoot, 'new-tracked-file.txt'), 'v1', 'utf8');
  const h2 = tools.hashWorkingTree(projectRoot);
  assert(h1 !== h2, 'hash should change after a new file is added');
  const h3 = tools.hashWorkingTree(projectRoot);
  assert(h2 === h3, 'hash should be stable when nothing changed between calls');
  console.log('[harness] hashWorkingTree: changes on real edits, stable otherwise');
}

function testTaskList(projectRoot) {
  const created = tools.upsertTask(projectRoot, { text: 'Do the thing', status: 'in_progress' });
  assert(created.id && created.status === 'in_progress', `expected a created task entry, got: ${JSON.stringify(created)}`);
  const updated = tools.upsertTask(projectRoot, { id: created.id, status: 'done' });
  assert(updated.status === 'done', 'update should change status on the same entry, not create a new one');
  const list = tools.listTasks(projectRoot);
  assert(list.length === 1 && list[0].status === 'done', `expected exactly 1 done task, got: ${JSON.stringify(list)}`);
  console.log('[harness] persistent task list: create and update by id both behave correctly');
}

function testRuleFiles(projectRoot) {
  const rulesDir = path.join(projectRoot, '.myclaudecode', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(
    path.join(rulesDir, 'ts.md'),
    '---\npaths: ["src/**/*.ts"]\n---\nAlways use strict null checks.\n',
    'utf8'
  );
  fs.writeFileSync(path.join(rulesDir, 'not-a-rule.txt'), 'ignored, wrong extension', 'utf8');

  const rules = tools.loadRuleFiles(projectRoot);
  assert(rules.length === 1, `expected exactly 1 loaded rule, got: ${JSON.stringify(rules)}`);
  assert(rules[0].paths.includes('src/**/*.ts'), 'expected the parsed paths array to include the glob');
  assert(/strict null checks/.test(rules[0].body), 'expected the rule body to be parsed out');

  console.log('[harness] rule-file loading: frontmatter paths + body parsed correctly, non-.md files ignored');
}

function testExternalTools(projectRoot) {
  fs.writeFileSync(
    path.join(projectRoot, '.myclaudecode', 'tools.json'),
    JSON.stringify([{ name: 'lint', description: 'Run the linter on a file', args: ['file'], command: 'eslint {file}' }]),
    'utf8'
  );
  const declared = tools.loadExternalTools(projectRoot);
  assert(declared.length === 1 && declared[0].name === 'lint', `expected 1 declared tool, got: ${JSON.stringify(declared)}`);

  const ToolCallParser = loadToolCallParser();
  const calls = ToolCallParser.parseToolCalls('!CALL_LINT src/app.js');
  assert(calls.length === 1 && calls[0].tool === 'CALL_LINT', `expected a CALL_LINT call, got: ${JSON.stringify(calls)}`);
  assert(calls[0].params.args[0] === 'src/app.js', 'expected the positional arg to be captured');

  console.log('[harness] declarative external tools: tools.json loading and !CALL_<NAME> parsing both behave correctly');
}

async function main() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-batch2-tools-'));
  console.log(`[harness] project root: ${projectRoot}`);

  testPermissionRules();
  testReadFilePagination(projectRoot);
  testHashWorkingTree(projectRoot);
  testTaskList(projectRoot);
  testRuleFiles(projectRoot);
  testExternalTools(projectRoot);

  console.log('\n[harness] PASS — permission rules, READ_FILE pagination, tree hashing, task list, rule files, and external tools all behave correctly.');
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[harness] FAILED:', err);
    process.exit(1);
  });
