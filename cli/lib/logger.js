// Laravel-style persistent log file — .myclaudecode/logs/myclaudecode-YYYY-MM-DD.log, one
// human-readable line per event, always on (independent of --verbose, which only controls
// what's echoed to the terminal). --verbose output scrolls away with the terminal buffer and
// only exists while the process is attached to a TTY; this is the thing you can tail -f
// during a run or open afterward to see exactly what each agent (planner/executor) was doing,
// what errors happened, and when — the file-based equivalent of storage/logs/laravel.log.
const fs = require('fs');
const path = require('path');

function logPath(configDir) {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, rotates daily like Laravel's 'daily' channel
  return path.join(configDir, 'logs', `myclaudecode-${day}.log`);
}

function write(configDir, level, role, message, context) {
  const file = logPath(configDir);
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const tag = role ? `${role}.${level}` : level;
  const ctx = context && Object.keys(context).length ? ` ${JSON.stringify(context)}` : '';
  const line = `[${ts}] ${tag}: ${message}${ctx}\n`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line, 'utf8');
  } catch (_) {
    // logging is best-effort — must never take down the task over a disk/permissions issue
  }
}

function makeLogger(configDir) {
  return {
    info: (role, message, context) => write(configDir, 'INFO', role, message, context),
    warning: (role, message, context) => write(configDir, 'WARNING', role, message, context),
    error: (role, message, context) => write(configDir, 'ERROR', role, message, context),
  };
}

module.exports = { makeLogger, logPath };
