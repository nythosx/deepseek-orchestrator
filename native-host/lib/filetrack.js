// native-host-side filetrack: mtime+size scan, snapshot persistence, dedup, bulk guard.
// Backs the FILETRACK_SCAN internal tool (see shared/protocol.js's TOOLS constant and
// native-host/host.js's execTool switch). Never reachable from model chat text — the
// FILETRACK_SCAN name is deliberately absent from toolCalls.js's TOOL_LINE_RE, so no
// response can trigger a scan.
//
// Design (per spec 4.4): mtime + size comparison, not hashing — any real edit updates
// mtime, and hashing every file on every check is overkill for <100ms scans on a few-
// hundred-file project. Dedup rule is simple: log a file change only if it's a different
// file from the last logged one (per-project lastLoggedPath), so a single editing session
// on one file produces one entry, not one per save. Bulk guard: >100 changes in one scan
// becomes one "bulk" entry (likely git checkout / pull / branch switch), and resets
// lastLoggedPath so the next single-file change logs normally again.
//
// Two exclusion lists, two purposes (per spec): filetrack's is deliberately SHORT so that
// .env, lockfiles, and .md changes DO get reported to the brain — compile.py's own
// exclusion list (which hides secrets from the bundle) is separate and unrelated.
const fs = require('fs');
const path = require('path');

const SNAPSHOT_FILE = '.myclaudecode/filetrack/snapshot.json';
const CHANGES_FILE = '.myclaudecode/filetrack/changes.jsonl';

// Shorter than compile.py's own exclusion list, on purpose — this list is what the brain
// gets to SEE, so we only exclude things that would obviously generate noise (git
// internals, the phased scripts dir which the orchestrator itself writes to, build
// artifacts).
const EXCLUDE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next']);
const EXCLUDE_PREFIXES = ['.myclaudecode/phased/scripts'];

function isExcluded(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  for (const part of parts) {
    if (EXCLUDE_DIRS.has(part)) return true;
  }
  for (const prefix of EXCLUDE_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(prefix + '/')) return true;
  }
  return false;
}

function scanProject(projectRoot) {
  const root = path.resolve(projectRoot);
  const entries = {};
  function walk(dir) {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (isExcluded(rel)) continue;
      if (item.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        const stat = fs.statSync(full);
        entries[rel] = { mtime: stat.mtimeMs, size: stat.size };
      } catch (_) {
        // file vanished between readdir and stat — skip it
      }
    }
  }
  walk(root);
  return entries;
}

function loadSnapshot(projectRoot) {
  const p = path.join(projectRoot, SNAPSHOT_FILE);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeSnapshot(projectRoot, entries, lastLoggedPath, lastLoggedAt) {
  const p = path.join(projectRoot, SNAPSHOT_FILE);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify(
      {
        version: 1,
        takenAt: Date.now(),
        entries,
        lastLoggedPath: lastLoggedPath || null,
        lastLoggedAt: lastLoggedAt || 0,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
}

function appendChange(projectRoot, change) {
  const p = path.join(projectRoot, CHANGES_FILE);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(change) + '\n', 'utf8');
}

function computeChanges(projectRoot, { mode, bulkThreshold = 100 } = {}) {
  const current = scanProject(projectRoot);
  const snapshot = loadSnapshot(projectRoot);

  // First run: no snapshot exists. Write a baseline, log nothing. No noise. (Per spec:
  // "First-run behavior: no snapshot → check returns empty, snapshot written.")
  if (!snapshot) {
    writeSnapshot(projectRoot, current, null, 0);
    return { changes: [], logged: [], deduped: [], bulk: false, isFirstRun: true };
  }

  const lastLoggedPath = snapshot.lastLoggedPath || null;
  const prev = snapshot.entries || {};

  const changes = [];
  for (const [rel, info] of Object.entries(current)) {
    const before = prev[rel];
    if (!before) {
      changes.push({ path: rel, action: 'created', mtime: info.mtime, size: info.size });
    } else if (before.mtime !== info.mtime || before.size !== info.size) {
      changes.push({ path: rel, action: 'modified', mtime: info.mtime, size: info.size });
    }
  }
  for (const rel of Object.keys(prev)) {
    if (!current[rel]) {
      changes.push({ path: rel, action: 'deleted', mtime: null, size: null });
    }
  }
  // Sort by mtime ascending (null mtime for deletes sorts first, which is fine).
  changes.sort((a, b) => (a.mtime || 0) - (b.mtime || 0));

  const result = { changes, logged: [], deduped: [], bulk: false, isFirstRun: false };

  // Bulk guard: if this one scan sees more than the threshold, collapse it into one entry
  // and reset lastLoggedPath so the next single-file change logs normally again.
  if (changes.length > bulkThreshold) {
    const bulkEntry = {
      ts: Date.now(),
      bulk: true,
      count: changes.length,
      sample: changes.slice(0, 10).map((c) => c.path),
      hint: 'likely git checkout / pull / branch switch',
    };
    appendChange(projectRoot, bulkEntry);
    result.logged.push(bulkEntry);
    result.bulk = true;
    if (mode === 'snapshot') {
      writeSnapshot(projectRoot, current, null, 0);
    }
    return result;
  }

  // Dedup-and-log loop. Simple rule (spec 4.4): skip logging a change if it's the same
  // file as the last-logged one — a single editing session on one file produces one entry,
  // not one per save.
  let nextLastLoggedPath = lastLoggedPath;
  let nextLastLoggedAt = snapshot.lastLoggedAt || 0;
  for (const change of changes) {
    if (change.path === lastLoggedPath) {
      result.deduped.push(change.path);
      continue;
    }
    const entry = {
      ts: Date.now(),
      path: change.path,
      action: change.action,
      mtime: change.mtime,
      size: change.size,
    };
    appendChange(projectRoot, entry);
    result.logged.push(entry);
    nextLastLoggedPath = change.path;
    nextLastLoggedAt = entry.ts;
  }

  // Write the new snapshot at end-of-scan (not only mode=snapshot): after logging, the new
  // state IS the baseline, so re-checking without writing would re-detect the same changes
  // on every scan. mode=snapshot only differs in that it also forces the write when there
  // were zero changes (e.g. task-end cleanup after a no-op phase).
  if (changes.length > 0 || mode === 'snapshot') {
    writeSnapshot(projectRoot, current, nextLastLoggedPath, nextLastLoggedAt);
  }

  return result;
}

module.exports = { computeChanges, scanProject, loadSnapshot };
