// Queryable record of past task runs — one JSON object per line in
// .myclaudecode/history.jsonl, appended to on every task_completed/task_error. Previously
// the only trace of a finished task was whatever scrolled past in the terminal; the single
// "last session" resume slot tracks live tabs, not a history of what actually happened.
const fs = require('fs');
const path = require('path');

function historyPath(configDir) {
  return path.join(configDir, 'history.jsonl');
}

function appendHistoryEntry(configDir, entry) {
  const line = `${JSON.stringify(entry)}\n`;
  fs.appendFileSync(historyPath(configDir), line, 'utf8');
}

function readHistory(configDir) {
  const file = historyPath(configDir);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null; // tolerate a corrupted/partial trailing line rather than failing the whole read
      }
    })
    .filter(Boolean);
}

module.exports = { historyPath, appendHistoryEntry, readHistory };
