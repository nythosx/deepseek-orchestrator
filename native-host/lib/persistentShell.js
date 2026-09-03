// One long-lived shell process per task, so `cd`/`export`/etc. issued by one !SHELL call
// actually persist to the next one — unlike a fresh spawn-per-call, which always resets to
// the project root with no state carried over. This is the single biggest gap between our
// SHELL tool and a real interactive terminal (or Claude Code's own Bash tool).
//
// Technique: after writing the real command to the shell's stdin, follow it with a command
// that echoes a random per-call sentinel plus the previous command's exit code. We read
// stdout until that sentinel appears, split everything before it off as the command's
// output, and parse the exit code out of the sentinel line itself. This is the standard way
// to get discrete request/response semantics out of an interactive shell's stdin/stdout.
const { spawn } = require('child_process');
const crypto = require('crypto');

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // kill an unused session after 10 minutes
const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const MAX_BUFFER = 10 * 1024 * 1024;
const SENTINEL_GRACE_MS = 40; // let trailing stderr for the same command catch up
// A control character, not a printable one — real command output essentially never contains
// it, so it's safe as a delimiter even though a Windows path (`C:\foo`) contains a literal
// colon that a naive `:`-split would trip over. Used to smuggle the ACTUAL post-command
// working directory back alongside the exit code (see the sentinel echo below) — observed
// live (2026-08-15): a task mixing !SHELL (persistent cwd, one real shell per task) and
// !SHELL_BG (always fresh, always rooted at the project) lost track of which directory it
// was actually "in," running commands against the wrong one. A model reasoning from memory
// about a `cd` it issued several turns ago is fragile; having the real cwd echoed back on
// EVERY !SHELL result, impossible to miss or misremember, is not.
const CWD_SEP = '\x01';

// taskId -> Session
const sessions = new Map();

function capBuffer(buf) {
  return buf.length > MAX_BUFFER ? buf.slice(-MAX_BUFFER) : buf;
}

class Session {
  constructor(taskId, shellPath, args, projectRoot, isCmd) {
    this.taskId = taskId;
    this.isCmd = isCmd;
    this.dead = false;
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this.queue = Promise.resolve();
    this.idleTimer = null;

    this.child = spawn(shellPath, args, { cwd: projectRoot, windowsHide: true });
    this.child.stdout.on('data', (d) => {
      this.stdoutBuf = capBuffer(this.stdoutBuf + d.toString());
    });
    this.child.stderr.on('data', (d) => {
      this.stderrBuf = capBuffer(this.stderrBuf + d.toString());
    });
    this.child.on('exit', () => {
      this.dead = true;
    });
    this.child.on('error', () => {
      this.dead = true;
    });

    this._armIdleTimer();
  }

  _armIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.kill(), IDLE_TIMEOUT_MS);
  }

  kill() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.dead = true;
    try {
      this.child.kill();
    } catch (_) {
      // already gone
    }
    sessions.delete(this.taskId);
  }

  run(command, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    this._armIdleTimer();
    // Serialize — only one command in flight per session at a time, since they share one
    // stdin/stdout pair with no way to multiplex.
    const next = this.queue.then(() => this._runOne(command, timeoutMs));
    // Swallow rejections here so one failed command doesn't wedge the queue for the next.
    this.queue = next.catch(() => {});
    return next;
  }

  _runOne(command, timeoutMs) {
    return new Promise((resolve) => {
      if (this.dead) {
        resolve({ stdout: '', stderr: 'Shell session has exited; a fresh one will start next call.', exitCode: null, timedOut: false });
        return;
      }

      const sentinel = `__SHELL_DONE_${crypto.randomBytes(8).toString('hex')}__`;
      this.stdoutBuf = '';
      this.stderrBuf = '';

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child.stdout.removeListener('data', onStdout);
        this.child.removeListener('exit', onExit);
        resolve(result);
      };

      const timer = setTimeout(() => {
        // The command (or the shell itself) appears hung. There's no way to interrupt just
        // this one command without risking it staying wedged behind future commands too, so
        // the whole session is sacrificed — the next !SHELL call gets a fresh one instead of
        // hanging forever. Losing cwd/env state here is an acceptable trade for not freezing
        // the rest of the task.
        finish({ stdout: this.stdoutBuf, stderr: this.stderrBuf, exitCode: null, timedOut: true });
        this.kill();
      }, timeoutMs);

      // A command that terminates the shell itself (`exit`, a fatal crash, the user's
      // command killing its own parent, etc.) means our sentinel echo never runs — without
      // this, we'd wait out the full timeout for something we could detect instantly.
      const onExit = (code) => {
        finish({ stdout: this.stdoutBuf, stderr: this.stderrBuf, exitCode: code, timedOut: false, sessionEnded: true });
      };
      this.child.once('exit', onExit);

      const sentinelRe = new RegExp(`${sentinel}:(-?\\d+)${CWD_SEP}([^\\r\\n]*)`);

      const onStdout = () => {
        const match = this.stdoutBuf.match(sentinelRe);
        if (!match) return;
        const exitCode = parseInt(match[1], 10);
        const cwd = (match[2] || '').trim() || null;
        const cleanStdout = this.stdoutBuf.slice(0, match.index);
        setTimeout(() => {
          finish({ stdout: cleanStdout, stderr: this.stderrBuf, exitCode, cwd, timedOut: false });
        }, SENTINEL_GRACE_MS);
      };

      this.child.stdout.on('data', onStdout);

      if (this.isCmd) {
        this.child.stdin.write(`${command}\r\n`);
        this.child.stdin.write(`echo ${sentinel}:%ERRORLEVEL%${CWD_SEP}%CD%\r\n`);
      } else {
        this.child.stdin.write(`${command}\n`);
        this.child.stdin.write(`printf '\\n%s:%s${CWD_SEP}%s\\n' '${sentinel}' "$?" "$(pwd)"\n`);
      }
    });
  }
}

function getOrCreateSession(taskId, projectRoot, shellPath, args, isCmd) {
  const existing = sessions.get(taskId);
  if (existing && !existing.dead) return existing;
  const session = new Session(taskId, shellPath, args, projectRoot, isCmd);
  sessions.set(taskId, session);
  return session;
}

function killSession(taskId) {
  const s = sessions.get(taskId);
  if (s) s.kill();
}

function killAll() {
  for (const s of Array.from(sessions.values())) s.kill();
}

module.exports = { getOrCreateSession, killSession, killAll };
