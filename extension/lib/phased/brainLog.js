// Persistent brain-response log (Addendum 2 Part K). Every response the brain gives in
// phased mode -- triage, batch ping, escalation, review -- is appended verbatim. The prompt
// side of the interaction is reconstructible from disk (phase plan, log.jsonl, current a.py);
// what we can't reconstruct is what the brain DECIDED, so this file is the bridge that lets
// a new brain tab resume from a rate-limit migration without depending on editMessage,
// self-summary, or the old tab's conversation.
//
// Read-modify-write via NativeBridge.execTool(READ_FILE/WRITE_FILE). Small file (one entry
// per brain interaction, tens of entries per task); the O(n) append is trivial.
//
// Cleared on TASK_COMPLETED and --close-session (spec Q3). Not cleared on --rewind (that's
// a filesystem operation, not session state -- post-mortem value > clean-slate value here).
const PhasedBrainLog = (() => {
  const PATH = '.myclaudecode/phased/brain-log.jsonl';

  async function _read(taskId) {
    try {
      const text = await NativeBridge.execTool(taskId, TOOLS.READ_FILE, { path: PATH });
      return typeof text === 'string' ? text : '';
    } catch (_) {
      return '';
    }
  }

  async function append(session, kind, rawText) {
    const existing = await _read(session.taskId);
    const base = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
    const entry = {
      ts: Date.now(),
      taskId: session.taskId,
      kind: kind || 'brain_response',
      raw: String(rawText || ''),
    };
    await NativeBridge.execTool(session.taskId, TOOLS.WRITE_FILE, {
      path: PATH,
      content: base + JSON.stringify(entry) + '\n',
    });
  }

  async function readRecent(session, limit) {
    const text = await _read(session.taskId);
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

  // The most recent entry whose kind indicates a triage decision. Used by buildBrainRecap to
  // reconstruct the CURRENT phase plan (per Addendum 2 Part K: "phase plan (extracted from
  // most recent triage_response in brain-log)"). Returns the parsed raw text, or null.
  async function readMostRecentTriage(session) {
    const entries = await readRecent(session, 30);
    const reversed = entries.slice().reverse();
    const hit = reversed.find((e) =>
      e && (e.kind === 'triage_response' || e.kind === 'escalation_response' || e.kind === 'replan_response')
    );
    return hit ? hit.raw : null;
  }

  // Clears the log. Called from runPhasedTask's finally when state === 'done' (spec Q3),
  // and from a future --close-session path. Best-effort -- a failed clear shouldn't fail
  // the task, and the next task's log just starts on top of stale entries (which is at
  // worst cosmetic, since entries are read by taskId-scoped callers).
  async function clear(session) {
    try {
      await NativeBridge.execTool(session.taskId, TOOLS.WRITE_FILE, { path: PATH, content: '' });
    } catch (_) {
      // best-effort
    }
  }

  return { append, readRecent, readMostRecentTriage, clear };
})();
