// Persistent per-task log + attention files (spec section 4.3). Both are JSONL, append-only,
// under .myclaudecode/phased/. Read-modify-write via NativeBridge.execTool(READ_FILE /
// WRITE_FILE) -- these files stay small (one line per phase run / per attention item), so
// the O(n) append cost is trivial and the two existing tools suffice. Phase 4 will add
// brain-log.jsonl on top of this same pattern (via brainLog.js).
//
// log.jsonl -- one entry per a.py run, success or failure, with exit code, duration, and
// the files it declared it wrote. Purely diagnostic; never read by the brain.
//
// attention.jsonl -- one entry per item the brain needs to see (failures, contract
// violations, exclusion-round drops). Severity is one of critical / high / medium / low;
// Phase 5's brainPinger decides when to surface them via the batching rules.
const PhasedLogStore = (() => {
  const LOG_PATH = '.myclaudecode/phased/log.jsonl';
  const ATTENTION_PATH = '.myclaudecode/phased/attention.jsonl';

  async function _read(taskId, filePath) {
    try {
      const text = await NativeBridge.execTool(taskId, TOOLS.READ_FILE, { path: filePath });
      return typeof text === 'string' ? text : '';
    } catch (_) {
      return '';
    }
  }

  async function _append(taskId, filePath, line) {
    const existing = await _read(taskId, filePath);
    // Only add a separator if existing content lacks a trailing newline -- avoids an empty
    // leading line on the very first append.
    const base = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
    const next = base + line + '\n';
    await NativeBridge.execTool(taskId, TOOLS.WRITE_FILE, { path: filePath, content: next });
  }

  async function appendLog(session, entry) {
    const line = JSON.stringify({ ts: Date.now(), ...entry });
    await _append(session.taskId, LOG_PATH, line);
  }

  async function appendAttention(session, item) {
    const line = JSON.stringify({ ts: Date.now(), ...item });
    await _append(session.taskId, ATTENTION_PATH, line);
  }

  function _parseLines(text, limit) {
    const lines = text.split('\n').filter(Boolean);
    const slice = limit ? lines.slice(-limit) : lines;
    return slice
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  }

  // Returns the last `limit` entries (or all entries if limit omitted). Malformed lines are
  // silently dropped -- a truncated trailing write (e.g. from a crashed prior run) shouldn't
  // break log reads for this run.
  async function readLog(session, limit) {
    return _parseLines(await _read(session.taskId, LOG_PATH), limit);
  }

  async function readAttention(session, limit) {
    return _parseLines(await _read(session.taskId, ATTENTION_PATH), limit);
  }

  return { appendLog, appendAttention, readLog, readAttention };
})();
