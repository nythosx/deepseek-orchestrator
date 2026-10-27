// Phased-mode entry point and coder loop core (Phase 3 of the phased-mode rollout).
//
// This file is loaded by extension/lib/phased/loader.js, which background.js importScripts's.
// It dispatches from background.js's handleCliPayload when options.phased === true. Legacy
// mode (Orchestrator.runTask) is completely untouched -- that's the structural choice this
// build makes: phased logic lives in its own files so orchestrator.js is never edited.
//
// Phase 3 scope: the loop skeleton that takes a phase plan, runs each phase through the
// coder (one a.py per phase, with traceback-retry up to apyMaxFixAttempts), parses markers,
// logs the run, and either advances or halts. Deliberately does NOT implement:
//   - triage (Phase 5)   -- falls back to .myclaudecode/phased/plan_override.json for testing
//   - migration (Phase 4) -- rate-limit / char-budget calls throw until Phase 4 lands
//   - batching pings (Phase 5) -- advanced phases proceed silently until brainPinger exists
//   - direct mode / escalation (Phase 5) -- triageMode='direct' branch throws a clear error
// Every cross-phase call below uses a `typeof X !== 'undefined'` guard, so this file never
// needs editing as later phases come online -- the modules simply appear in loader.js's
// already-enumerated list, and the guarded calls activate automatically.
const PhasedRunner = (() => {
  // Raised from 100000 (2026-10-25): DeepSeek's real per-chat limit is ~210K chars,
  // so 180K gives 30K headroom while leaving room for the response side. With the
  // bundle-cap fix in brainLayer.triage below, this covers a typical phased task
  // end to end (triage turn + first coder turn) without a mid-flight migration.
  const DEFAULT_CHAR_BUDGET = 180000;
  const MAX_PHASES = 40;              // spec F.1 -- brain triage may exceed; loop caps.
  const SHELL_OUTPUT_LINES_FOR_MARKERS = 200;
  // Phase 29 (2026-10-25): Switched from in-memory `Map` to chrome.storage.local.
  // Reason: Manifest V3 service workers terminate when idle. The old in-memory Map was
  // lost every time the SW went to sleep, causing the next task to spawn new tabs
  // instead of reusing the existing ones. Now the tab IDs survive SW restarts and CLI
  // restarts.
  const KEPT_ANSWER_TABS_KEY = 'phased_kept_answer_tabs';
  const KEPT_CODER_TABS_KEY = 'phased_kept_coder_tabs';

  // Entries are { tabId, chars }: chars is the tab's accumulated conversation size, so a
  // reused tab resumes its char-budget count instead of looking empty (which skipped the
  // proactive migration and let a long-reused chat run into DeepSeek's length limit).
  // Older entries stored a bare tabId; those read back as chars: 0.
  async function getKeptTab(key, projectRoot) {
    try {
      const data = await chrome.storage.local.get(key);
      const map = data[key] || {};
      const entry = map[projectRoot];
      if (entry == null) return null;
      if (typeof entry === 'number') return { tabId: entry, chars: 0, url: '' };
      return typeof entry.tabId === 'number' || entry.url
        ? { tabId: entry.tabId, chars: entry.chars || 0, url: entry.url || '' }
        : null;
    } catch (_) { return null; }
  }

  async function setKeptTab(key, projectRoot, tabId, chars) {
    try {
      let url = '';
      try {
        const tab = await chrome.tabs.get(tabId);
        url = (tab && (tab.url || tab.pendingUrl)) || '';
      } catch (_) {}
      const data = await chrome.storage.local.get(key);
      const map = data[key] || {};
      const prev = map[projectRoot];
      if (!CONVERSATION_URL_RE.test(url) && prev && prev.tabId === tabId) url = prev.url || url;
      map[projectRoot] = { tabId, chars: chars || 0, url };
      await chrome.storage.local.set({ [key]: map });
    } catch (_) {}
  }

  const CONVERSATION_URL_RE = /^https:\/\/chat\.deepseek\.com\/a\/chat\/s\/[\w-]+/;

  async function resolveKeptTab(key, projectRoot) {
    const kept = await getKeptTab(key, projectRoot);
    if (!kept) return null;
    const usable = (tab) => tab && /chat\.deepseek\.com/.test(tab.url || tab.pendingUrl || '');
    let tab = null;
    if (typeof kept.tabId === 'number') {
      try { tab = await chrome.tabs.get(kept.tabId); } catch (_) { tab = null; }
    }
    if (!usable(tab) && CONVERSATION_URL_RE.test(kept.url)) {
      const conv = kept.url.match(CONVERSATION_URL_RE)[0];
      try {
        const open = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
        tab = open.find((t) => (t.url || '').startsWith(conv)) || null;
      } catch (_) { tab = null; }
      if (!tab) {
        try { tab = await chrome.tabs.create({ url: conv, active: false }); } catch (_) { tab = null; }
        if (tab) console.log('[phased] reopened kept conversation', conv);
      }
    }
    if (!usable(tab)) return null;
    try {
      if (tab.discarded) await chrome.tabs.reload(tab.id);
      await TabManager.waitForReady(tab.id);
    } catch (_) { return null; }
    return { tabId: tab.id, chars: kept.chars };
  }

  try {
    chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
      for (const key of [KEPT_ANSWER_TABS_KEY, KEPT_CODER_TABS_KEY]) {
        try {
          const data = await chrome.storage.local.get(key);
          const map = data[key] || {};
          let changed = false;
          for (const root of Object.keys(map)) {
            if (map[root] && map[root].tabId === removedTabId) { map[root].tabId = addedTabId; changed = true; }
          }
          if (changed) await chrome.storage.local.set({ [key]: map });
        } catch (_) {}
      }
    });
  } catch (_) {}

  // Phase 22 (2026-10-25): pending phased-mode user questions. The legacy
  // Orchestrator.askUser path only resolves through Orchestrator.answerQuestion.
  // Phased mode (particularly [RUN]) needs its own map so it can ask the user
  // (e.g. "install deps?") without touching legacy code. background.js wires
  // ANSWER_USER_QUESTION to BOTH Orchestrator.answerQuestion and
  // PhasedRunner.answerPhasedQuestion, so either side resolves cleanly.
  const phasedPendingQuestions = new Map();

  async function phasedAskUser(session, question, options) {
    const questionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
    notifyCli(session, {
      type: CLI_MESSAGE_TYPES.USER_QUESTION_REQUIRED,
      taskId: session.taskId,
      questionId,
      question,
      options: Array.isArray(options) ? options : [],
    });
    return new Promise((resolve) => {
      phasedPendingQuestions.set(questionId, resolve);
    });
  }

  function answerPhasedQuestion(questionId, answer) {
    const r = phasedPendingQuestions.get(questionId);
    if (r) {
      phasedPendingQuestions.delete(questionId);
      r(answer);
    }
  }

  // --- helpers ---------------------------------------------------------------

  function withTimestamp(text, session) {
    // Spec 3.4: every prompt starts with `[time: YYYY-MM-DD HH:MM:SS <TZ>]` followed by a
    // blank line. session.timezone is from the CLI (Intl), or null if missing -- fall back
    // to UTC so this never fails a task over a missing timestamp (spec 3.4 last paragraph).
    const tz = (session && session.timezone) || 'UTC';
    let dateStr;
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      }).formatToParts(new Date());
      const get = (k) => (parts.find((p) => p.type === k) || {}).value || '00';
      dateStr = `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
    } catch (_) {
      dateStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
    }
    // Phase 24 (2026-10-25): add [cwd: ...] alongside [time:]. The brain reads
    // this to know where the shell currently is, so it can decide whether to
    // cd or use absolute paths for its next command. Falls back to projectRoot
    // when session.currentCwd is unset (fresh session, no SHELL runs yet).
    const cwd = (session && (session.currentCwd || session.projectRoot)) || '(unknown)';
    return `[time: ${dateStr} ${tz}]\n[cwd: ${cwd}]\n\n${text}`;
  }

  // Single choke point for every message this file sends to the CLI. Mirrors
  // Orchestrator's own notifyCli contract: a cancelled session produces no further output.
  // The session object is registered in Orchestrator.sessions (see newPhasedSession), so
  // Orchestrator.cancelTask sets `session.cancelled` here -- no extra plumbing needed.
  function notifyCli(session, payload) {
    if (session && session.cancelled) return;
    if (!payload.taskId && session) payload.taskId = session.taskId;
    NativeBridge.sendToCli(payload);
  }

  // Windows paths through !SHELL (persistent shell = Git Bash) must use forward slashes --
  // backslashes get eaten as escape characters, and Windows Python accepts forward-slash
  // paths too, so one form works for both. On POSIX this is a no-op (no backslashes).
  function toForwardSlash(p) {
    return String(p || '').replace(/\\/g, '/');
  }

  // --- session lifecycle -----------------------------------------------------

  function newPhasedSession(taskId, task, options, config, permissions, projectRoot) {
    const session = {
      // Identity
      taskId,
      taskDescription: task,
      projectRoot,
      // Phase 24 (2026-10-25): shell's actual working directory, updated after
      // every SHELL command that returns a cwd field. Surfaced to the brain in
      // every prompt as [cwd: ...] so it can't forget where the shell is.
      // Initialized null; withTimestamp falls back to projectRoot when null.
      currentCwd: null,
      timezone: (options && options.timezone) || null,
      os: (options && options.os) || null,
      continueTabs: !!(options && options.resume),
      permissions: permissions || {},

      // Config (read with `??` fallbacks per Addendum 2 H.5 -- user configs may not have
      // these keys yet; defaults from shared/protocol.js fill the gap).
      phasedConfig: (config && config.phased) || {},
      filetrackConfig: (config && config.filetrack) || {},
      filetrackOverride:
        options && options.filetrack != null ? options.filetrack : null,
      charBudget: (config && config.charBudget) || DEFAULT_CHAR_BUDGET,

      // Runtime mode: always 'phased' for this session (it's the phased runner). triageMode
      // is what the triage decision picks (direct vs phased) -- see spec Part 2.
      runtimeMode: 'phased',
      triageMode: null,

      // Tabs
      brainTabId: null,
      coderTabId: null,

      // Profile IDs (foundational for v2 cross-profile migration per Q6)
      ownProfileId: null,
      brainProfileId: null,

      // Counters
      brainMsgCount: 0,
      brainCharCount: 0,
      coderMsgCount: 0,
      coderCharCount: 0,
      totalDeepSeekTurns: 0,
      totalApyRuns: 0,

      // Progress
      state: 'init',
      cancelled: false,
      successStreak: 0,
      phasesAttempted: 0,
      phasesSucceeded: 0,
      phasesEscalated: 0,
      directEscalations: 0,
      escalationCycles: 0,

      // Plan (populated after triage; overridable for Phase 3 testing)
      phasePlan: null,
      phasePlanOverride:
        (options && options.phasePlanOverride) || null,
      completedPhases: [],
      currentPhaseIndex: 0,
      directBrief: null,
    };

    // Register in Orchestrator.sessions so Orchestrator.cancelTask and its notifyCli work
    // transparently. Runner's own finally block deletes it. Best-effort: if Orchestrator
    // isn't loaded (shouldn't happen -- background.js importScripts's it first), skip.
    try {
      if (typeof Orchestrator !== 'undefined' && Orchestrator.sessions) {
        Orchestrator.sessions.set(taskId, session);
      }
    } catch (_) {}

    return session;
  }

  // --- send-and-track (phased) -----------------------------------------------

  // Phased-mode counterpart of orchestrator.js's sendAndTrack. Differences:
  //   - withTimestamp() prepended (spec 3.4)
  //   - brain responses logged to brain-log.jsonl via PhasedBrainLog (Phase 4)
  //   - rate-limit / char-budget errors delegated to PhasedMigration (Phase 4)
  //   - no legacy migration / self-summary path (this runner is not using editMessage)
  async function sendAndTrack(session, role, text, opts) {
    opts = opts || {};
    if (session.cancelled) throw new Error('Task cancelled.');

    if (role !== 'planner' && session.coderReady) await session.coderReady;

    const tabKey = role === 'planner' ? 'brainTabId' : 'coderTabId';
    const tabId = session[tabKey];
    if (tabBusy.has(tabId)) await tabBusy.get(tabId);
    if (tabId == null) throw new Error(`No ${role} tab available.`);

    // Char-budget check (same shape as legacy's, so a phased task's per-tab budget
    // behaves identically -- the difference is what happens on overflow: migratePhased
    // instead of migrate+summarize). Falls through to throw if Phase 4 not built yet.
    const charCountKey = role === 'planner' ? 'brainCharCount' : 'coderCharCount';
    // Skip the proactive char_budget migration on the FIRST send (charCount === 0). A
    // fresh tab has no accumulated content yet -- the first message is the initial
    // context, not growth. If it's genuinely too big for DeepSeek (rare, >~210K chars),
    // the reactive length_limit path migrates. Proactively migrating on the first send
    // is worse than useless: the new tab gets a BRAIN RECAP with no plan and no history,
    // and the brain has no context to triage from. Bug observed live 2026-10-25 in the
    // candy-crush analysis run (migrated on turn 1, triage then failed to parse).
    if (
      session.phasedConfig && session.phasedConfig.proactiveCharBudgetMigration &&
      session[charCountKey] > 0 &&
      session[charCountKey] + text.length >= session.charBudget
    ) {
      if (typeof PhasedMigration !== 'undefined' && PhasedMigration.migrate) {
        return PhasedMigration.migrate(session, role, 'char_budget', text);
      }
      throw new Error(
        'char_budget: message would exceed budget and phased migration is not built yet (Phase 4).'
      );
    }

    const timestamped = withTimestamp(text, session);
    notifyCli(session, { type: CLI_MESSAGE_TYPES.THINKING_STARTED, role });

    // Images ride along with this message: explicit ones from the caller, or for the
    // brain, whatever !ATTACH_IMAGE / !INSPECT_TAB queued since its last message.
    let attachments = opts.attachments || null;
    if (!attachments && role === 'planner' && session.pendingBrainAttachments && session.pendingBrainAttachments.length) {
      attachments = session.pendingBrainAttachments;
      session.pendingBrainAttachments = [];
    }

    const start = Date.now();
    const res = await TabManager.sendToTabResilient(tabId, {
      action: 'typeAndSend',
      text: timestamped,
      instant: opts.instant,
      attachments: attachments && attachments.length
        ? attachments.map(({ name, mime, base64 }) => ({ name, mime, base64 }))
        : undefined,
    });
    const elapsed = Date.now() - start;

    const attachRep = res && res.attachmentReport;
    if (attachRep && attachRep.failed && attachRep.failed.length) {
      notifyCli(session, {
        type: CLI_MESSAGE_TYPES.PLANNER_THINKING,
        text: '(system) ⚠️ Could not attach to the DeepSeek message: ' +
          attachRep.failed.map((f) => `${f.name} (${f.error})`).join('; '),
      });
    }

    notifyCli(session, {
      type: CLI_MESSAGE_TYPES.TIMING,
      phase: 'tab_reply',
      role,
      elapsedMs: elapsed,
      promptChars: timestamped.length,
      replyChars: (res && res.text && res.text.length) || 0,
      diagnostics: (res && res.diagnostics) || null,
    });

    if (res && res.error) {
      // Rate limit path (spec Addendum 2 Part J). Phase 4's PhasedMigration handles the
      // backoff-then-migrate sequence; until then, throw with the RATE_LIMIT: prefix
      // visible so log analysis can distinguish it.
      if (/RATE_LIMIT:/i.test(res.error)) {
        if (typeof PhasedMigration !== 'undefined' && PhasedMigration.waitOutRateLimit) {
          const attempt = (opts._rateLimitAttempt || 0) + 1;
          await PhasedMigration.waitOutRateLimit(session, role, res.error, attempt);
          return sendAndTrack(session, role, text, { ...opts, attachments, _rateLimitAttempt: attempt });
        }
        throw new Error(res.error);
      }
      // Length limit reached -- migrate (Phase 4) or throw.
      if (/length limit reached/i.test(res.error)) {
        if (typeof PhasedMigration !== 'undefined' && PhasedMigration.migrate) {
          return PhasedMigration.migrate(session, role, 'chat_full', text);
        }
        throw new Error(res.error);
      }
      throw new Error(`Failed to send to ${role} tab: ${res.error}`);
    }

    // Update counters.
    if (role === 'planner') {
      session.brainMsgCount++;
      session.brainCharCount += timestamped.length + (res.text || '').length;
    } else {
      session.coderMsgCount++;
      session.coderCharCount += timestamped.length + (res.text || '').length;
    }
    session.totalDeepSeekTurns++;

    // Brain-response persistence (Phase 4). Best-effort -- losing a brain-log line shouldn't
    // fail the task. The `kind` field distinguishes triage responses from batch-ping
    // responses from escalation responses in the recap builder.
    if (role === 'planner' && typeof PhasedBrainLog !== 'undefined' && PhasedBrainLog.append) {
      const kind = opts.brainLogKind || 'brain_response';
      await PhasedBrainLog.append(session, kind, res.text || '').catch(() => {});
    }

    const needBundle = role !== 'planner' && !opts._bundleRetry && /^\s*\[NEED_BUNDLE\]\s*(.*)$/m.exec(res.text || '');
    if (needBundle) {
      await supplyBundleToCoder(session, needBundle[1]);
      return sendAndTrack(session, role, text, { ...opts, _bundleRetry: true });
    }

    return res.text;
  }

  function currentTaskFiles(session) {
    const phase = session.phasePlan && session.phasePlan[session.currentPhaseIndex || 0];
    if (phase && Array.isArray(phase.files) && phase.files.length) return phase.files;
    return (session.directBrief && session.directBrief.files_to_touch) || [];
  }

  async function supplyBundleToCoder(session, requested) {
    const asked = String(requested || '').split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
    const paths = [...new Set([...asked, ...currentTaskFiles(session)])];
    notifyCli(session, {
      type: CLI_MESSAGE_TYPES.PLANNER_THINKING,
      text: `(system) Coder says it has no compiled bundle. Compiling ${paths.join(', ') || '(nothing)'} for it.`,
    });
    let bundle = null;
    if (paths.length && typeof PhasedBundleBuilder !== 'undefined') {
      try {
        const compiled = await PhasedBundleBuilder.compileSelected(session, paths);
        if (compiled.ok) bundle = compiled.content;
      } catch (err) {
        console.warn('[phased] NEED_BUNDLE compile failed:', err.message);
      }
    }
    if (!bundle && session.compiledBundle) bundle = session.compiledBundle;
    const message = bundle
      ? 'CONTEXT FOR THE TASK YOU ASKED ABOUT. Here is the compiled bundle. Reply with only: OK\n\n' + bundle
      : 'The system could not compile a bundle for those files (missing or over the size limit). ' +
        'Work from the file contents in the task prompt; your a.py may read files itself. Reply with only: OK';
    const timestamped = withTimestamp(message, session);
    const res = await TabManager.sendToTabResilient(session.coderTabId, { action: 'typeAndSend', text: timestamped, instant: true });
    if (res && res.error) throw new Error(`Failed to send bundle to coder: ${res.error}`);
    session.coderMsgCount++;
    session.coderCharCount += timestamped.length + ((res && res.text) || '').length;
    session.totalDeepSeekTurns++;
    if (bundle) session.coderSharedBundleChars = bundle.length;
  }

  // Q6 foundation: a named send-to-brain wrapper. In v1 this just calls sendAndTrack with
  // role='planner' -- it exists so v2's cross-profile routing becomes a swap of this
  // function's body, without touching any call site. All phased code that talks to the
  // brain should route through this, not call sendAndTrack('planner', ...) directly.
  async function sendToBrain(session, text, opts) {
    return sendAndTrack(session, 'planner', text, opts || {});
  }

  // --- a.py extraction and execution -----------------------------------------

  // Picks the LAST ```python block from the coder's reply. Per spec B.2: multiple blocks
  // -> take the last (that's the "here's the fixed version"); a non-python language tag
  // is treated as no block at all (caller retries), because the coder is instructed to
  // produce Python only.
  function extractApy(text) {
    if (!text) return null;
    const pyBlocks = [];
    // Match ```python or ```py explicitly first -- the coder is told to use one of these.
    const re = /```(?:python|py)\s*\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text)) !== null) pyBlocks.push(m[1]);
    if (pyBlocks.length) return pyBlocks[pyBlocks.length - 1];
    // Fallback: bare ``` with no language tag -- accept it, this is common enough that
    // rejecting outright would waste a retry cycle.
    const bareBlocks = [];
    const bare = /```\n([\s\S]*?)```/g;
    while ((m = bare.exec(text)) !== null) bareBlocks.push(m[1]);
    if (bareBlocks.length) return bareBlocks[bareBlocks.length - 1];
    return null;
  }

  async function writeApy(session, filename, content) {
    const relPath = `.myclaudecode/phased/scripts/${filename}`;
    await NativeBridge.execTool(session.taskId, TOOLS.WRITE_FILE, {
      path: relPath,
      content,
    });
    return relPath;
  }

  async function runApy(session, relPath) {
    const startedAt = Date.now();
    const projectRootFwd = toForwardSlash(session.projectRoot);
    const apyFwd = `${projectRootFwd}/${toForwardSlash(relPath)}`;
    // cd-then-run, both quoted. See toForwardSlash's comment: forward slashes work in both
    // Git Bash and cmd.exe, so this is shell-agnostic. Known limitation: persistent-shell
    // DEFAULT_COMMAND_TIMEOUT_MS is 30s (native-host/lib/persistentShell.js) -- a.py that
    // runs a genuinely long build would hit it. Phase 3 tests use short a.py's so this
    // isn't exercised yet; Phase 7's e2e harness can use SHELL_BG if needed.
    const command = `cd "${projectRootFwd}" && python "${apyFwd}"`;
    const res = await NativeBridge.execTool(session.taskId, TOOLS.SHELL, { command });
    if (res && res.cwd) session.currentCwd = res.cwd;
    session.totalApyRuns++;
    return {
      stdout: (res && res.stdout) || '',
      stderr: (res && res.stderr) || '',
      exitCode: res && res.exitCode != null ? res.exitCode : 1,
      durationMs: Date.now() - startedAt,
      timedOut: !!(res && res.timedOut),
    };
  }

  // Write + run, return all the parsed signals. Callers decide the policy (success /
  // soft_success / failure) based on the mode.
  async function runApyWithMarkers(session, filename, apyContent) {
    const relPath = await writeApy(session, filename, apyContent);
    const run = await runApy(session, relPath);
    const tail = PhasedMarkers.lastNlines(run.stdout, SHELL_OUTPUT_LINES_FOR_MARKERS);
    const successMarker = PhasedMarkers.parseSuccess(tail);
    const filesTouched = PhasedMarkers.parseWrote(tail);
    const classification = PhasedMarkers.classify(run, successMarker);
    return { relPath, run, successMarker, filesTouched, classification };
  }

  // Public helper for Phase 5's brainLayer (runDirect). Kept separate from
  // runApyWithMarkers so a future direct-mode-specific policy can be layered without
  // touching the phased-mode loop.
  async function writeAndRunApy(session, filename, apyContent) {
    return runApyWithMarkers(session, filename, apyContent);
  }

  // --- coder prompt -----------------------------------------------------------

  // The full prompt is Phase 5's PhasedBrainLayer.buildCoderPrompt, using APY_CODER_PROMPT.
  // Phase 3's fallback here is intentionally minimal -- enough for the loop to be exercised
  // end-to-end without the primer yet existing. Once Phase 5 lands, the guarded call
  // takes over and this branch is dead code (kept for defensive safety).
  async function buildCoderPrompt(session, phase, index, total, attempt, currentApy, lastTraceback) {
    if (typeof PhasedBrainLayer !== 'undefined' && PhasedBrainLayer.buildCoderPrompt) {
      return PhasedBrainLayer.buildCoderPrompt(
        session, phase, index, total, attempt, currentApy, lastTraceback
      );
    }
    if (attempt === 1) {
      const phaseSummary =
        `Phase ${index + 1}/${total}: ${phase.name}\n` +
        `Goal: ${phase.goal || '(no goal)'}\n` +
        `Files: ${(phase.files || []).join(', ')}\n` +
        `Tests: ${phase.tests || '(unspecified)'}`;
      return (
        `You are a coding agent producing ONE Python script that implements a specific change.\n` +
        `Output EXACTLY ONE \`\`\`python code block. No prose before or after.\n\n` +
        `=== SCOPE ===\n${phaseSummary}\n\n` +
        `Rules:\n` +
        `- No code comments anywhere.\n` +
        `- Idempotent -- safe to run twice.\n` +
        `- Print __PHASE_WROTE__ <comma,separated,paths> before running tests.\n` +
        `- Print __PHASE_SUCCESS__ on its own line after all tests pass.\n\n` +
        `Output format: one \`\`\`python code block. Nothing else.`
      );
    }
    return (
      `Running the previous a.py failed (attempt ${attempt}).\n\n` +
      `Current a.py:\n\`\`\`python\n${currentApy || ''}\n\`\`\`\n\n` +
      `Traceback:\n\`\`\`\n${lastTraceback || '(none)'}\n\`\`\`\n\n` +
      `Fix a.py and output the whole file again in one \`\`\`python code block. ` +
      `No comments. Idempotent. Same protocol rules as before ` +
      `(__PHASE_WROTE__ before tests, __PHASE_SUCCESS__ after tests pass).`
    );
  }

  // --- phase loop -------------------------------------------------------------

  async function runPhasedMode(session) {
    const phases = session.phasePlan;
    if (!Array.isArray(phases) || !phases.length) {
      throw new Error('No phase plan available.');
    }
    if (phases.length > MAX_PHASES) {
      throw new Error(
        `Phase plan has ${phases.length} phases, exceeds MAX_PHASES=${MAX_PHASES}. ` +
        `Truncate or replan before Phase 3's loop (Phase 5's triage handles this).`
      );
    }
    const total = phases.length;
    const maxAttempts = (session.phasedConfig && session.phasedConfig.apyMaxFixAttempts) || 3;

    for (let i = session.currentPhaseIndex; i < total; i++) {
      if (session.cancelled) throw new Error('Task cancelled.');
      session.currentPhaseIndex = i;
      const phase = phases[i];
      session.state = 'phased_running';
      notifyCli(session, {
        type: CLI_MESSAGE_TYPES.PHASE_STARTED,
        phase: phase.name,
        index: i + 1,
        total,
      });

      let attempt = 1;
      let currentApy = null;
      let lastTraceback = '';
      let result = null;

      while (attempt <= maxAttempts) {
        if (session.cancelled) throw new Error('Task cancelled.');
        const coderPrompt = await buildCoderPrompt(
          session, phase, i, total, attempt, currentApy, lastTraceback
        );
        const coderReply = await sendAndTrack(session, 'executor', coderPrompt, {
          instant: true,
          brainLogKind: 'coder_response',
        });
        currentApy = extractApy(coderReply);
        if (!currentApy) {
          lastTraceback = 'Coder produced no ```python block.';
          attempt++;
          continue;
        }
        const filename = PhasedScriptNaming.phaseFilename(i + 1, phase.name, attempt);
        result = await runApyWithMarkers(session, filename, currentApy);
        if (result.classification.outcome === 'failure') {
          lastTraceback = PhasedMarkers.lastNlines(result.run.stderr || result.run.stdout, 200).slice(-4000);
          await PhasedLogStore.appendLog(session, {
            phase: phase.name,
            attempt,
            exitCode: result.run.exitCode,
            successMarker: result.successMarker,
            durationMs: result.run.durationMs,
            filesTouched: result.filesTouched,
          }).catch(() => {});
          attempt++;
          continue;
        }
        // Success or soft-success: log + advance. Soft-success is a spec H.3 decision --
        // phased mode tolerates a missing marker (Phase 5's batch ping will surface it),
        // because phased has a mechanism to catch silently-broken a.py's; direct mode does
        // not and applies a stricter bar in its own path.
        if (result.classification.outcome === 'soft_success') {
          await PhasedLogStore.appendAttention(session, {
            phase: phase.name,
            kind: 'missing_marker_soft',
            severity: 'medium',
            detail: `a.py exited 0 but no __PHASE_SUCCESS__ marker in last ${SHELL_OUTPUT_LINES_FOR_MARKERS} lines of stdout.`,
          }).catch(() => {});
        }
        await PhasedLogStore.appendLog(session, {
          phase: phase.name,
          attempt,
          exitCode: result.run.exitCode,
          successMarker: result.successMarker,
          durationMs: result.run.durationMs,
          filesTouched: result.filesTouched,
        }).catch(() => {});
        notifyCli(session, {
          type: CLI_MESSAGE_TYPES.PHASE_SUCCESS,
          phase: phase.name,
          durationMs: result.run.durationMs,
          filesTouched: result.filesTouched,
        });
        session.phasesSucceeded++;
        session.successStreak++;
        session.completedPhases.push({ name: phase.name, index: i, filename });
        break;
      }

      if (!result || result.classification.outcome === 'failure') {
        session.phasesAttempted++;
        await PhasedLogStore.appendAttention(session, {
          phase: phase.name,
          kind: 'failure',
          severity: 'critical',
          detail: `Phase failed after ${maxAttempts} attempts. Traceback: ${lastTraceback.slice(0, 500)}`,
        }).catch(() => {});
        notifyCli(session, {
          type: CLI_MESSAGE_TYPES.PHASE_FAILED,
          phase: phase.name,
          attempts: maxAttempts,
          traceback: lastTraceback,
        });
        throw new Error(`Phase ${phase.name} failed after ${maxAttempts} attempts.`);
      }
      session.phasesAttempted++;

      // Batching: Phase 5's PhasedBrainPinger decides whether to ping. Until then,
      // phases advance silently (the pinger module doesn't exist yet, so the guarded
      // branch is skipped -- a phased run in Phase 3 is functionally "run all phases
      // without a brain checkpoint").
      if (typeof PhasedBrainPinger !== 'undefined' && typeof PhasedBrainLayer !== 'undefined') {
        if (PhasedBrainPinger.shouldPing(session)) {
          await PhasedBrainLayer.ping(session);
          session.successStreak = 0;
        }
      }
    }

    session.state = 'done';
  }

  // --- brain tool calls (Phase 24) ------------------------------------------
  //
  // Read-only tool execution for the brain during triage. Previously the brain
  // could only see the bundle and had to answer "I can't inspect that" when a
  // question was about a path outside the bundle (e.g. another project on the
  // same machine). Now the brain can issue up to 3 read-only tool calls per
  // turn, the orchestrator runs them, and the brain gets the results in the
  // follow-up prompt before producing its final triage decision.
  //
  // Strictly read-only tools. WRITE_FILE/EDIT_FILE/SHELL/etc are NOT allowed --
  // the brain doesn't need to mutate anything during triage, and allowing them
  // would bypass the coder step entirely.
  const PHASED_BRAIN_TOOLS = new Set([
    TOOLS.LS,
    TOOLS.READ_FILE,
    TOOLS.GREP,
    TOOLS.FIND_FILE,
    TOOLS.HTTP_GET,
    TOOLS.INSPECT_TAB,
    TOOLS.ATTACH_IMAGE,
    TOOLS.COMPILE_BUNDLE,
  ]);

  // An !INSPECT_TAB or RUN-result screenshot goes to the brain as a real image on its
  // next message (it used to be written to disk as base64 text the brain never saw).
  function queueScreenshot(session, base64) {
    if (!base64) return false;
    const pending = session.pendingBrainAttachments || (session.pendingBrainAttachments = []);
    if (pending.length >= 5) return false;
    pending.push({ name: `screenshot-${Date.now()}.png`, mime: 'image/png', base64 });
    return true;
  }

  const BRAIN_TOOL_RESULT_MAX = 8000;
  function capBrainToolResult(s) {
    const str = typeof s === 'string' ? s : JSON.stringify(s);
    if (str.length <= BRAIN_TOOL_RESULT_MAX) return str;
    return str.slice(0, BRAIN_TOOL_RESULT_MAX) +
      `\n…(truncated, ${str.length - BRAIN_TOOL_RESULT_MAX} more chars)`;
  }

  const CODER_SHARE_FILE_MAX = 60000;
  const CODER_SHARE_TOTAL_MAX = 150000;

  const tabBusy = new Map();

  function sendContextToCoder(session, text, notice) {
    const prev = session.coderBackground || session.coderReady || Promise.resolve();
    const job = prev.catch(() => {}).then(async () => {
      const tabId = session.coderTabId;
      if (session.cancelled || tabId == null) return;
      if (session.coderCharCount + text.length >= session.charBudget) return;
      const timestamped = withTimestamp(text, session);
      const res = await TabManager.sendToTabResilient(tabId, { action: 'typeAndSend', text: timestamped, instant: true });
      if (res && res.error) throw new Error(res.error);
      session.coderMsgCount++;
      session.coderCharCount += timestamped.length + ((res && res.text) || '').length;
      session.totalDeepSeekTurns++;
    }).catch((err) => console.warn('[phased] sending context to coder failed:', err.message));
    session.coderBackground = job;
    session.coderReady && session.coderReady.then(() => {
      if (session.coderTabId == null) return;
      tabBusy.set(session.coderTabId, job);
      job.then(() => { if (tabBusy.get(session.coderTabId) === job) tabBusy.delete(session.coderTabId); });
    }).catch(() => {});
    notifyCli(session, { type: CLI_MESSAGE_TYPES.PLANNER_THINKING, text: notice });
  }

  function shareBundleWithCoder(session, bundle) {
    if (!bundle || session.coderSharedBundleChars === bundle.length) return;
    session.coderSharedBundleChars = bundle.length;
    sendContextToCoder(
      session,
      'CONTEXT FOR A LATER TASK. This is the project code bundle the planner compiled for the ' +
        'current task. Analyze and remember it; the task that uses it will come later. ' +
        'Do NOT write code or explain anything now. Reply with only: OK\n\n' + bundle,
      `(system) Shared the compiled bundle (${bundle.length} chars) with the coder tab.`
    );
  }

  function shareFilesWithCoder(session, files) {
    if (!files.length) return;
    const seen = session.coderSharedFiles || (session.coderSharedFiles = {});
    const fresh = files.filter((f) => seen[f.path] !== f.content.length);
    if (!fresh.length) return;
    let total = 0;
    const parts = [];
    for (const f of fresh) {
      if (total >= CODER_SHARE_TOTAL_MAX) break;
      const body = f.content.length > CODER_SHARE_FILE_MAX
        ? f.content.slice(0, CODER_SHARE_FILE_MAX) + '\n…(truncated)'
        : f.content;
      parts.push(`----- FILE: ${f.path} -----\n${body}`);
      total += body.length;
      seen[f.path] = f.content.length;
    }
    const text =
      'CONTEXT FOR A LATER TASK. The planner just read these project files. ' +
      'Analyze and remember them; a task that uses them will come later. ' +
      'Do NOT write code or explain anything now. Reply with only: OK\n\n' +
      parts.join('\n\n');
    sendContextToCoder(session, text, `(system) Shared ${parts.length} file(s) the brain read with the coder tab.`);
  }

  function callLabel(call) {
    if (call.tool === TOOLS.COMPILE_BUNDLE) {
      return (call.params.paths || []).length ? call.params.paths.join(', ') : '(your compile.py)';
    }
    return JSON.stringify(call.params);
  }

  async function runBrainToolCalls(session, calls) {
    const outputs = [];
    const readFiles = [];
    for (const call of calls) {
      // Filter: not-allowed tools get a clear notice rather than executing.
      if (!PHASED_BRAIN_TOOLS.has(call.tool)) {
        outputs.push(
          `(tool result for !${call.tool})\n` +
          `NOT EXECUTED: ${call.tool} is not available in phased triage. ` +
          `Allowed tools: COMPILE_BUNDLE, LS, READ_FILE, GREP, FIND_FILE, HTTP_GET, INSPECT_TAB, ATTACH_IMAGE.`
        );
        continue;
      }
      if (session.compileMustFix && call.tool !== TOOLS.COMPILE_BUNDLE) {
        outputs.push(
          `(tool result for !${call.tool} ${callLabel(call)})\n` +
          'NOT EXECUTED: your compile.py failed. Fix the compile first: send !COMPILE_BUNDLE with the ' +
          'corrected compile.py in a code block. Other files can be read only after the bundle passes.'
        );
        continue;
      }
      session.toolCallCount = (session.toolCallCount || 0) + 1;
      notifyCli(session, {
        type: CLI_MESSAGE_TYPES.TOOL_CALL,
        taskId: session.taskId,
        role: 'planner',
        tool: call.tool,
        params: call.params,
      });
      try {
        let result;
        let uncapped = false;
        if (call.tool === TOOLS.COMPILE_BUNDLE) {
          const compiled = (call.params.paths || []).length
            ? await PhasedBundleBuilder.compileSelected(session, call.params.paths)
            : await PhasedBundleBuilder.compileFromScript(session, call.params.script);
          session.compileMustFix = !compiled.ok;
          if (compiled.error) {
            result = `FAILED: ${compiled.error}\nFix your compile.py and send !COMPILE_BUNDLE with the corrected \`\`\`python block.`;
          } else if (compiled.ok) {
            session.compiledBundle = compiled.content;
            shareBundleWithCoder(session, compiled.content);
            uncapped = true;
            result = `PASSED the size rule (${compiled.chars} of ${compiled.limit} chars, ${compiled.files} files). ` +
              `The same bundle was sent to the coder.\n\n${compiled.content}`;
          } else {
            result = `FAILED the size rule: ${compiled.chars} chars, limit ${compiled.limit}. Nothing was sent. ` +
              `Retry !COMPILE_BUNDLE with fewer paths. Largest files in your selection:\n` +
              compiled.largest.map((f) => `  ${f.chars}  ${f.path}`).join('\n');
          }
        } else if (call.tool === TOOLS.INSPECT_TAB) {
          const inspectResult = await TabManager.inspectTab(call.params.url);
          const shot = queueScreenshot(session, inspectResult.screenshotBase64);
          result = {
            loadError: inspectResult.loadError || null,
            page: inspectResult.pageInfo || null,
            console: (inspectResult.logs || []).slice(0, 60).map((l) => `[${l.level}] ${l.text}`),
            failedRequests: inspectResult.failedRequests || [],
            screenshot: shot ? 'attached to this message' : 'not captured',
          };
        } else if (call.tool === TOOLS.ATTACH_IMAGE) {
          const pending = session.pendingBrainAttachments || (session.pendingBrainAttachments = []);
          if (pending.length >= PhasedImages.MAX_IMAGES_PER_MESSAGE) {
            throw new Error(`At most ${PhasedImages.MAX_IMAGES_PER_MESSAGE} images per message.`);
          }
          const img = await PhasedImages.load(session, call.params.ref);
          pending.push(img);
          result = `Attached to this message: ${PhasedImages.describe(img)}`;
        } else {
          const execParams =
            call.tool === TOOLS.HTTP_GET
              ? call.params
              : { ...call.params, allowOutside: true };
          result = await NativeBridge.execTool(session.taskId, call.tool, execParams);
          if (call.tool === TOOLS.READ_FILE && typeof result === 'string' && call.params && call.params.path) {
            readFiles.push({ path: call.params.path, content: result });
          }
        }
        // Capture cwd after SHELL if we ever support it here in the future.
        if (call.tool === TOOLS.SHELL && result && result.cwd) {
          session.currentCwd = result.cwd;
        }
        const formatted =
          `(tool result for !${call.tool} ${callLabel(call)})\n` +
          (uncapped ? result : capBrainToolResult(result));
        outputs.push(formatted);
        notifyCli(session, {
          type: CLI_MESSAGE_TYPES.TOOL_CALL_RESULT,
          taskId: session.taskId,
          role: 'planner',
          tool: call.tool,
          params: call.params,
          result,
        });
      } catch (err) {
        outputs.push(
          `(tool result for !${call.tool} ${callLabel(call)})\n` +
          `ERROR: ${err.message}`
        );
        notifyCli(session, {
          type: CLI_MESSAGE_TYPES.TOOL_CALL_RESULT,
          taskId: session.taskId,
          role: 'planner',
          tool: call.tool,
          params: call.params,
          error: err.message,
        });
      }
    }
    shareFilesWithCoder(session, readFiles);
    return outputs.join('\n\n');
  }

  // --- [RUN] mode (Phase 22) -------------------------------------------------
  //
  // The brain produced a plan of commands to execute. No coder involvement, no
  // a.py -- the deliverable is a running project. Steps execute in order:
  //   - check: run, ignore exit code (status probe)
  //   - ask: prompt user; anything starting with No/n/skip/cancel/deny/abort
  //          aborts the run
  //   - shell: run blocking, non-zero exit aborts the run with the stderr
  //   - bg: run in background (SHELL_BG); typically a dev server
  //   - open: after all commands, open the target with OPEN_APP
  //
  // A failed step or console errors on the opened page go back to the brain
  // (runRunFollowUp) for up to runFixRounds() rounds before the run gives up.
  // A user declining an ask: step, or cancelling, still aborts immediately.
  async function runRunMode(session, runPlan, round = 0) {
    const detect = runPlan.detect || '(no detect line)';
    const commands = Array.isArray(runPlan.commands) ? runPlan.commands : [];
    const open = runPlan.open || null;

    // Announce the plan up front, so the user knows what will happen before
    // any command runs.
    const planLines = [`[RUN] ${detect}`];
    if (commands.length) {
      planLines.push('Plan:');
      commands.forEach((c, i) => {
        const desc =
          c.kind === 'ask' ? `ASK: ${c.question}` :
          c.kind === 'check' ? `CHECK: ${c.value}` :
          c.kind === 'bg' ? `BG: ${c.value}` :
          `SHELL: ${c.value}`;
        planLines.push(`  ${i + 1}. ${desc}`);
      });
    }
    if (open) planLines.push(`Open: ${open}`);
    notifyCli(session, {
      type: CLI_MESSAGE_TYPES.PLANNER_THINKING,
      text: planLines.join('\n'),
    });

    session.triageMode = 'run';
    session.state = 'phased_running';
    const total = commands.length;
    session.runBgIds = session.runBgIds || [];

    for (let i = 0; i < commands.length; i++) {
      if (session.cancelled) throw new Error('Task cancelled.');
      const step = commands[i];
      notifyCli(session, {
        type: CLI_MESSAGE_TYPES.PHASE_STARTED,
        phase: `run-step-${i + 1}`,
        index: i + 1,
        total,
      });

      const stepStart = Date.now();
      try {
        // Phase 24 (2026-10-25): shell:/check: commands in [RUN] mode get
        // `cd "<projectRoot>" &&` prepended automatically. This is a safety
        // net against cwd drift -- if the brain cd'd somewhere else during
        // triage inspection, or a previous step left the shell in a strange
        // place, relative paths still resolve to the project root. Brain can
        // override with its own `cd /abs/path && ...` (the second cd wins).
        const projectRootFwd = toForwardSlash(session.projectRoot);
        if (step.kind === 'ask') {
          const answer = await phasedAskUser(
            session,
            step.question,
            step.options && step.options.length ? step.options : ['Yes', 'No'],
          );
          const a = String(answer || '').trim();
          if (/^(no|n|skip|cancel|deny|abort)\b/i.test(a)) {
            throw new Error(`User declined at step ${i + 1}: "${step.question}" (answered: ${a})`);
          }
        } else if (step.kind === 'check') {
          // Informational probe. Ignore exit code AND any transient error so a
          // non-zero `test -d node_modules` doesn't kill the whole plan.
          try {
            const checkRes = await NativeBridge.execTool(session.taskId, TOOLS.SHELL, {
              command: `cd "${projectRootFwd}" && ${step.value}`,
            });
            if (checkRes && checkRes.cwd) session.currentCwd = checkRes.cwd;
          } catch (_) {}
        } else if (step.kind === 'shell') {
          const res = await NativeBridge.execTool(session.taskId, TOOLS.SHELL, {
            command: `cd "${projectRootFwd}" && ${step.value}`,
          });
          if (res && res.cwd) session.currentCwd = res.cwd;
          if (res && res.exitCode !== 0) {
            const stdout = (res.stdout || '').slice(0, 1000);
            const stderr = (res.stderr || '').slice(0, 1000);
            throw new Error(
              `Command failed at step ${i + 1}: ${step.value}\n` +
              `exit=${res.exitCode}\n` +
              (stdout ? `stdout: ${stdout}\n` : '') +
              (stderr ? `stderr: ${stderr}` : '')
            );
          }
        } else if (step.kind === 'bg') {
          const res = await NativeBridge.execTool(session.taskId, TOOLS.SHELL_BG, { command: step.value });
          if (res && res.denied) {
            throw new Error(`Background command denied at step ${i + 1}: ${step.value}`);
          }
          if (res && res.id) session.runBgIds.push(res.id);
        } else {
          throw new Error(`Unknown RUN step kind at ${i + 1}: ${step.kind}`);
        }
      } catch (err) {
        notifyCli(session, {
          type: CLI_MESSAGE_TYPES.PHASE_FAILED,
          phase: `run-step-${i + 1}`,
          attempts: 1,
          traceback: err.message,
        });
        if (session.cancelled || /^User declined at step/.test(err.message)) throw err;
        const note = await runRunFollowUp(session, runPlan, round, { verdict: 'not_running', stepFailure: err.message });
        if (note === null) return;
        throw new Error(`${err.message}\n\n${note}`);
      }

      notifyCli(session, {
        type: CLI_MESSAGE_TYPES.PHASE_SUCCESS,
        phase: `run-step-${i + 1}`,
        durationMs: Date.now() - stepStart,
        filesTouched: [],
      });
    }

    let check = null;
    if (open) {
      try {
        check = await checkRunTarget(session, open);
      } catch (err) {
        check = { url: open, verdict: 'unchecked', note: `Inspecting "${open}" threw: ${err.message}` };
      }
      notifyCli(session, {
        type: CLI_MESSAGE_TYPES.PLANNER_THINKING,
        text: `(system) ${verdictLabel(check.verdict)}: ${check.url}` + (check.note ? ` -- ${check.note}` : ''),
      });
    }

    // The brain always hears how its plan actually went -- including a clean run, so
    // a follow-up question in this same conversation starts from what really happened.
    let followUpNote = null;
    if (check && !session.cancelled) {
      followUpNote = await runRunFollowUp(session, runPlan, round, check);
      if (followUpNote === null) return;
    }

    session.state = 'done';
    const stepLabel = total === 0 ? 'no setup steps needed' : `${total} step(s) succeeded`;
    let finalSummary =
      `[RUN] ${detect} -- ${stepLabel}` +
      (open ? `, opened ${check ? check.url : open}` : '') +
      `. Tabs left open for inspection.`;
    if (check) finalSummary += '\n\n' + formatCheckForUser(check);
    if (round > 0) finalSummary += `\n(${round} follow-up fix round(s) applied.)`;
    if (followUpNote) finalSummary += '\n\n' + followUpNote;

    await finishTask(session, {
      type: CLI_MESSAGE_TYPES.TASK_COMPLETED,
      summary: finalSummary,
      stats: {
        plannerTurns: session.brainMsgCount,
        executorTurns: session.coderMsgCount,
        toolCalls: session.totalApyRuns,
        phasesAttempted: session.phasesAttempted,
        phasesSucceeded: session.phasesSucceeded,
        directEscalations: session.directEscalations,
      },
    });
  }

  function runFixRounds(session) {
    const n = session.phasedConfig && session.phasedConfig.runFixRounds;
    return Number.isInteger(n) && n >= 0 ? n : 2;
  }

  async function killRunBgProcs(session) {
    for (const id of session.runBgIds || []) {
      await NativeBridge.execTool(session.taskId, TOOLS.PROC_KILL, { id }).catch(() => {});
    }
    session.runBgIds = [];
  }

  async function bgProcLogs(session) {
    const logs = [];
    for (const id of session.runBgIds || []) {
      try {
        logs.push(String(await NativeBridge.execTool(session.taskId, TOOLS.PROC_LOG, { id, lines: 40 })));
      } catch (_) {}
    }
    return logs;
  }

  // A dev server can take several seconds to bind (or never bind: port in use, wrong
  // directory). Polls the URL instead of sleeping a fixed time -- the old 2s sleep
  // meant a slow server got inspected as Chrome's "can't connect" error page. Stops
  // early once every bg: process has exited, since nothing is coming up then.
  const RUN_SERVER_WAIT_MS = 20000;

  async function waitForServer(session, url) {
    const start = Date.now();
    let lastErr = null;
    while (Date.now() - start < RUN_SERVER_WAIT_MS) {
      if (session.cancelled) throw new Error('Task cancelled.');
      try {
        const res = await NativeBridge.execTool(session.taskId, TOOLS.HTTP_GET, { url });
        return { up: true, status: res && res.status, waitedMs: Date.now() - start };
      } catch (err) {
        lastErr = err.message;
      }
      const ids = session.runBgIds || [];
      if (ids.length) {
        const logs = await bgProcLogs(session);
        if (logs.length === ids.length && logs.every((l) => /\(exited with code/.test(l))) {
          return { up: false, error: 'the bg: server process exited before serving the URL', waitedMs: Date.now() - start };
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { up: false, error: lastErr || 'no response', waitedMs: Date.now() - start };
  }

  // Waits for the server, opens the page with the console recorder (TabManager.inspectTab)
  // and boils the result down to one verdict the brain and user both see:
  //   running              page loaded, rendered something, no errors
  //   running_with_errors  page loaded but logged errors / failed requests / rendered blank
  //   not_running          server never answered, or the page failed to load
  //   unchecked            the inspector itself could not look at the page
  async function checkRunTarget(session, open) {
    let url = open;
    if (!/^(https?|file):\/\//i.test(url)) {
      const rel = url.replace(/^\.?[\\/]/, '').replace(/\\/g, '/');
      url = 'file:///' + toForwardSlash(session.projectRoot).replace(/^\/+/, '') + '/' + rel;
    }
    const check = { url, verdict: 'unchecked', server: null, inspection: null, screenshotPath: null, screenshotAttached: false, note: null };

    if (/^https?:\/\//i.test(url)) {
      check.server = await waitForServer(session, url);
      if (!check.server.up) {
        check.verdict = 'not_running';
        check.note = `nothing answered at ${url} after ${Math.round(check.server.waitedMs / 1000)}s (${check.server.error})`;
        check.bgLogs = await bgProcLogs(session);
        return check;
      }
    }

    if (typeof TabManager === 'undefined' || !TabManager.inspectTab) {
      await NativeBridge.execTool(session.taskId, TOOLS.OPEN_APP, { command: open }).catch(() => {});
      check.note = 'inspector not available; opened with the OS default handler';
      return check;
    }

    const ins = await TabManager.inspectTab(url);
    check.inspection = ins;
    check.screenshotAttached = queueScreenshot(session, ins.screenshotBase64);
    check.bgLogs = await bgProcLogs(session);
    if (ins.screenshotBase64) {
      check.screenshotPath = `.myclaudecode/screenshots/screenshot_${Date.now()}.b64`;
      await NativeBridge.execTool(session.taskId, TOOLS.WRITE_FILE, {
        path: check.screenshotPath,
        content: ins.screenshotBase64,
      }).catch(() => { check.screenshotPath = null; });
    }

    const logs = ins.logs || [];
    const pageErrors = logs.filter((l) => l.level === 'error');
    const failed = ins.failedRequests || [];
    const info = ins.pageInfo;
    const blank = info && !info.text && !info.canvases && info.elements < 3;
    if (ins.loadError) {
      check.verdict = 'not_running';
      check.note = `page failed to load (${ins.loadError})`;
    } else if (!info && !logs.length && (ins.errors || []).some((e) => /^Failed to inject error listener/.test(e))) {
      check.verdict = 'unchecked';
      check.note = ins.errors.join('; ');
    } else if (pageErrors.length || failed.length || blank) {
      check.verdict = 'running_with_errors';
      check.note = [
        pageErrors.length ? `${pageErrors.length} console error(s)` : '',
        failed.length ? `${failed.length} failed request(s)` : '',
        blank ? 'page rendered nothing' : '',
      ].filter(Boolean).join(', ');
    } else {
      check.verdict = 'running';
    }
    return check;
  }

  function verdictLabel(v) {
    return {
      running: '✅ Project is running',
      running_with_errors: '⚠️ Project is running, with errors',
      not_running: '❌ Project is NOT running',
      unchecked: '❔ Could not verify the project',
    }[v] || v;
  }

  // Console output as the brain sees it, capped so a chatty page can't flood the chat.
  function formatConsoleLogs(logs, maxLines, maxChars) {
    const out = [];
    let chars = 0;
    for (const l of logs) {
      const line = `[${l.level}] ${l.text}`;
      if (out.length >= maxLines || chars + line.length > maxChars) {
        out.push(`... (${logs.length - out.length} more line(s) omitted)`);
        break;
      }
      out.push(line);
      chars += line.length;
    }
    return out.join('\n');
  }

  function formatCheckForBrain(check) {
    const parts = [`VERDICT: ${check.verdict.toUpperCase()} -- ${verdictLabel(check.verdict)}` +
      (check.note ? ` (${check.note})` : '')];
    parts.push(`URL: ${check.url}`);
    const ins = check.inspection;
    if (ins) {
      if (ins.pageInfo) {
        const i = ins.pageInfo;
        parts.push(`Page: title=${JSON.stringify(i.title || '')}, ${i.elements} elements, ${i.canvases} canvas(es), ` +
          `visible text=${JSON.stringify(i.text || '')}`);
      }
      const logs = ins.logs || [];
      if (check.screenshotAttached) parts.push('Screenshot of the page: attached to this message.');
      parts.push('Browser console (from page load + 3s):\n' +
        (logs.length ? formatConsoleLogs(logs, 60, 6000) : '(no console output)'));
      if ((ins.failedRequests || []).length) {
        parts.push('Failed network requests:\n' + ins.failedRequests.slice(0, 20).map((r) => '- ' + r).join('\n'));
      }
    }
    if (check.bgLogs && check.bgLogs.length) {
      parts.push('Background server output (tail):\n' + check.bgLogs.map((l) => l.slice(-3000)).join('\n'));
    }
    return parts.join('\n\n');
  }

  function formatCheckForUser(check) {
    const lines = [verdictLabel(check.verdict) + (check.note ? ` -- ${check.note}` : '')];
    const ins = check.inspection;
    const shown = ((ins && ins.logs) || []).filter((l) => l.level === 'error' || l.level === 'warn');
    if (shown.length) lines.push(formatConsoleLogs(shown, 10, 2000).replace(/^/gm, '  '));
    if (ins && (ins.failedRequests || []).length) {
      lines.push(ins.failedRequests.slice(0, 5).map((r) => '  ' + r).join('\n'));
    }
    if (ins && ins.logs && ins.logs.length) {
      lines.push(`  (${ins.logs.length} console line(s) captured and sent to the brain)`);
    }
    if (check.screenshotPath) lines.push(`(Screenshot saved to ${check.screenshotPath})`);
    return lines.join('\n');
  }

  // Reports how a [RUN] actually went back to the brain -- every run, not just failed
  // ones -- and acts on its reply:
  //   [ANSWER] -> its verdict/explanation, returned for the caller's summary
  //   [RUN]    -> corrected plan; old bg processes are killed and it re-runs
  //   [DIRECT] -> code fix; applied only if the user agrees (they asked to RUN
  //               the project, not to change it), then the same plan re-runs
  // [RUN]/[DIRECT] are only offered while fix rounds remain. Returns null when a
  // re-run took over (it reports completion itself), otherwise a note.
  async function runRunFollowUp(session, runPlan, round, check) {
    const fixRound = round + 1;
    const canFix = round < runFixRounds(session);
    const ok = check.verdict === 'running';
    notifyCli(session, {
      type: CLI_MESSAGE_TYPES.PLANNER_THINKING,
      text: ok || !canFix
        ? '(system) Reporting the run result to the brain.'
        : `(system) Run had problems -- asking the brain for a fix (round ${fixRound}/${runFixRounds(session)}).`,
    });

    const planText = [
      `detect: ${runPlan.detect}`,
      'commands:',
      ...(runPlan.commands || []).map((c) =>
        c.kind === 'ask' ? `- ask: ${c.question}` : `- ${c.kind}: ${c.value}`),
      runPlan.open ? `open: ${runPlan.open}` : '',
    ].filter(Boolean).join('\n');

    let what;
    if (check.stepFailure) {
      const bg = await bgProcLogs(session);
      what = 'VERDICT: NOT_RUNNING -- a command in your plan FAILED:\n' + check.stepFailure.slice(0, 3000) +
        (bg.length ? '\n\nBackground server output (tail):\n' + bg.map((l) => l.slice(-3000)).join('\n') : '');
    } else {
      what = formatCheckForBrain(check);
    }

    const replyRules = !canFix
      ? 'No fix rounds are left. Reply with [ANSWER] only (under 800 chars): say plainly\n' +
        'whether the project runs, and what the user should do about any remaining errors.'
      : ok
        ? 'The project IS running. Reply with [ANSWER] and a one-line confirmation of what is\n' +
          'up (under 300 chars). Only if the console output above shows a real bug, reply\n' +
          'with [RUN] or [DIRECT] instead (see below).\n\n' + fixModes()
        : 'Diagnose the ROOT CAUSE first, then reply with exactly ONE of:\n' + fixModes();

    let prompt =
      `(system) RUN RESULT (round ${round}) -- here is what actually happened when your [RUN] plan executed.\n\n` +
      'Plan that was executed:\n' + planText + '\n\n' +
      what + '\n\n' +
      replyRules;

    let parsed = null;
    for (let toolRounds = 0, parseAttempts = 0; ;) {
      if (session.cancelled) throw new Error('Task cancelled.');
      const response = await sendToBrain(session, prompt, {
        instant: true,
        brainLogKind: 'run_followup_response',
      });
      let calls = [];
      try {
        if (typeof ToolCallParser !== 'undefined') calls = ToolCallParser.parseToolCalls(response);
      } catch (_) {}
      if (calls.length && toolRounds < 1 && canFix) {
        toolRounds++;
        const results = await runBrainToolCalls(session, calls);
        prompt =
          '(system) Tool results:\n\n' + results + '\n\n' +
          'Now reply with exactly ONE of [RUN], [DIRECT] (with [BRIEF]), or [ANSWER]. No more tool calls.';
        continue;
      }
      parsed = PhasedTriageParser.parseTriageResponse(response);
      if (parsed.ok || ++parseAttempts >= 2) break;
      prompt =
        '(system) Could not parse your reply: ' + (parsed.error || 'unknown') + '\n' +
        (canFix
          ? 'Reply with exactly ONE of [RUN], [DIRECT] [EST_LOC n] with [BRIEF]...[/BRIEF], or [ANSWER].'
          : 'Reply with [ANSWER] followed by your text.');
    }

    if (!parsed.ok) {
      return `Run follow-up: the brain's reply could not be parsed (${parsed.error || 'unknown'}).`;
    }
    if (parsed.mode === 'answer') {
      return 'Brain says: ' + parsed.answer;
    }
    if (!canFix) {
      return `Brain proposed another [${String(parsed.mode).toUpperCase()}] fix, but no fix rounds are left (runFixRounds=${runFixRounds(session)}).`;
    }
    if (parsed.mode === 'run' && parsed.runPlan) {
      await killRunBgProcs(session);
      await runRunMode(session, parsed.runPlan, fixRound);
      return null;
    }
    if (parsed.mode === 'direct' && parsed.brief) {
      const files = (parsed.brief.files_to_touch || []).join(', ');
      const answer = await phasedAskUser(
        session,
        `The app has errors. DeepSeek proposes a code fix${files ? ` touching ${files}` : ''}. Apply it and re-run?`,
        ['Yes fix it', 'No leave it'],
      );
      if (/^(no|n|skip|cancel|deny|abort)\b/i.test(String(answer || '').trim())) {
        return 'Brain proposed a code fix; you declined it, so the errors above remain.';
      }
      await PhasedBrainLayer.runDirect(session, parsed.brief);
      await killRunBgProcs(session);
      await runRunMode(session, runPlan, fixRound);
      return null;
    }
    return `Brain proposed a [${String(parsed.mode).toUpperCase()}] fix, which run follow-up does not apply. Re-run it as a fix task.`;
  }

  function fixModes() {
    return (
      '  [RUN]    -- the PLAN was wrong (wrong port/URL, wrong server, missing install\n' +
      '              step, opened a file:// page that needs HTTP, port already in use).\n' +
      '              Give the full corrected plan; it replaces the old one and the old\n' +
      '              bg: processes are stopped first.\n' +
      '  [DIRECT] [EST_LOC n] with [BRIEF]...[/BRIEF] -- the project CODE is broken\n' +
      '              (bad import path, typo, missing file the code references). The user\n' +
      '              is asked before it is applied; the same plan re-runs afterwards.\n' +
      '  [ANSWER] -- it works, the errors are harmless, or they need something only the\n' +
      '              user can do (API key, database, system install). Under 800 chars.\n' +
      'You may first use !READ_FILE / !LS / !GREP / !HTTP_GET (one round) to look at the\n' +
      'files or URLs named in the errors. Do NOT guess -- "Failed to resolve module\n' +
      'specifier", a 404, or a stack trace names the exact file to check.\n\n' +
      'DIAGNOSIS CHECKLIST (go top to bottom, stop at the first match):\n' +
      '  1. A command failed -> read its exact error line; missing tool/dep = [RUN] with\n' +
      '     the install step, wrong path/script name = [RUN] with the right one.\n' +
      '  2. The server log shows a build/compile error -> it names file:line. Read THAT\n' +
      '     file (and the file it imports from) before a [DIRECT]; the brief must name\n' +
      '     the real symbol to import/export, never "reconcile whatever is there".\n' +
      '  3. Log says ready/listening but the URL timed out -> use your tool round on the\n' +
      '     entry file\'s request handler (the "main"/entry from the manifest or config)\n' +
      '     and one !HTTP_GET of a tiny route (/favicon.ico, a static file). Static\n' +
      '     works + / hangs = the handler awaits something unbounded; both hang =\n' +
      '     wrong host/port or the server is still starting ([RUN], same plan is fine).\n' +
      '  4. Address in use / EADDRINUSE -> [RUN] on another free port.\n' +
      '  5. Page loads but the console shows errors / failed requests -> the first\n' +
      '     error\'s file and URL are the lead; a 404 for /api/* means the backend\n' +
      '     half is not the one running.\n' +
      '  6. Needs a secret, account, paid API, or a running service the user owns ->\n' +
      '     [ANSWER] naming exactly what to set and where.\n' +
      'A [DIRECT] about a file you have not READ this conversation is a guess. Read it\n' +
      'first, or use [ANSWER] and say which file must be checked.\n' +
      'No [PHASED] here: if the fix is that large, use [ANSWER] and say so.'
    );
  }

  // --- plan override (Phase 3 test path only) --------------------------------

  // Reads .myclaudecode/phased/plan_override.json if it exists and returns the phases
  // array (or null). Used exclusively for Phase 3's manual verification -- Phase 5's
  // real triage supersedes this and Phase 7's e2e tests exercise the real path.
  async function loadPlanOverride(session) {
    if (session.phasePlanOverride) return session.phasePlanOverride;
    try {
      const text = await NativeBridge.execTool(session.taskId, TOOLS.READ_FILE, {
        path: '.myclaudecode/phased/plan_override.json',
      });
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.phases)) return parsed.phases;
      return null;
    } catch (_) {
      return null;
    }
  }

  // --- top-level task lifecycle ----------------------------------------------

  async function saveKeptTabs(session) {
    if (session.coderReady) await session.coderReady.catch(() => {});
    if (session.brainTabId != null) {
      await setKeptTab(KEPT_ANSWER_TABS_KEY, session.projectRoot, session.brainTabId, session.brainCharCount);
    }
    if (session.coderTabId != null) {
      await setKeptTab(KEPT_CODER_TABS_KEY, session.projectRoot, session.coderTabId, session.coderCharCount);
    }
  }

  async function finishTask(session, payload) {
    await saveKeptTabs(session).catch(() => {});
    notifyCli(session, payload);
  }

  async function runPhasedTask(session) {
    try {
      session.state = 'init';

      // Tabs: brain (planner-role) + coder (executor-role). Same TabManager primitives as
      // legacy -- the roles just mean something different now.
      const tabStart = Date.now();
      // Try to reuse a brain tab kept open from a prior [ANSWER] task in this same CLI
      // process, for the SAME project. Enables "analyze project" then "what about X?"
      // to continue in the same conversation without re-sending the bundle.
      let brainTabId = null;
      let brainReused = false;
      const kept = session.continueTabs ? await resolveKeptTab(KEPT_ANSWER_TABS_KEY, session.projectRoot) : null;
      if (kept) {
        brainTabId = kept.tabId;
        brainReused = true;
        session.brainCharCount = kept.chars;
        console.log('[phased] reusing kept brain tab', kept.tabId, 'for project', session.projectRoot);
      }
      if (brainTabId == null) {
        brainTabId = await TabManager.createPlannerTab(session.taskId);
        await TabManager.waitForReady(brainTabId);
      }
      session.brainTabId = brainTabId;
      session.brainTabReused = brainReused;
      // PHASE-20-CODER-UPFRONT-START
      // Create the coder tab now (alongside the brain tab) and prime it while
      // triage runs, so it is warm by the time a direct/phase task arrives.
      // Reuse a kept coder tab from a prior task in this CLI process when
      // possible (keptCoderTabs, saved in the finally block below). Only prime
      // on a fresh tab; a reused tab already has the base rules from before.
      session.coderReady = (async () => {
      let coderTabId = null;
      let coderReused = false;
      const keptCoder = session.continueTabs ? await resolveKeptTab(KEPT_CODER_TABS_KEY, session.projectRoot) : null;
      if (keptCoder) {
        coderTabId = keptCoder.tabId;
        coderReused = true;
        session.coderCharCount = keptCoder.chars;
        console.log('[phased] reusing kept coder tab', keptCoder.tabId, 'for', session.projectRoot);
      }
      if (coderTabId == null) {
        coderTabId = await TabManager.createExecutorTab(session.taskId);
        await TabManager.waitForReady(coderTabId);
      }
      session.coderTabId = coderTabId;
      session.coderTabReused = coderReused;
      if (!coderReused) {
        const primerStart = Date.now();
        try {
          const primerText =
            typeof PhasedBrainLayer !== 'undefined' && typeof PhasedBrainLayer.buildCoderPrimer === 'function'
              ? await PhasedBrainLayer.buildCoderPrimer(session)
              : 'You are a coding agent producing ONE Python script per task. Output exactly one ```python block per task. Wait for the task prompt.';
          const primerRes = await TabManager.sendToTabResilient(coderTabId, {
            action: 'typeAndSend',
            text: withTimestamp(primerText, session),
            instant: true,
          });
          if (primerRes && primerRes.error) {
            throw new Error('coder primer send failed: ' + primerRes.error);
          }
          session.coderMsgCount++;
          session.coderCharCount +=
            primerText.length + ((primerRes && primerRes.text) || '').length;
          session.totalDeepSeekTurns++;
          notifyCli(session, {
            type: CLI_MESSAGE_TYPES.TIMING,
            phase: 'executor_primer',
            role: 'executor',
            elapsedMs: Date.now() - primerStart,
            promptChars: primerText.length,
            reused: false,
          });
        } catch (err) {
          throw new Error('Failed to prime coder tab: ' + err.message);
        }
      } else {
        notifyCli(session, {
          type: CLI_MESSAGE_TYPES.TIMING,
          phase: 'executor_primer',
          role: 'executor',
          elapsedMs: 0,
          reused: true,
        });
      }
      })();
      session.coderReady.catch(() => {});
      // PHASE-20-CODER-UPFRONT-END

      notifyCli(session, {
        type: CLI_MESSAGE_TYPES.TIMING,
        phase: 'tab_setup',
        elapsedMs: Date.now() - tabStart,
        reused: brainReused,
      });

      // Triage. Phase 5 provides PhasedBrainLayer.triage; Phase 3 falls back to the
      // plan-override file (documented above) so the loop can be exercised end-to-end
      // before the brain layer exists.
      session.state = 'triaging';
      let plan;
      const override = await loadPlanOverride(session);
      if (override) {
        plan = { mode: 'phased', phases: override, estimate: null };
      } else if (typeof PhasedBrainLayer !== 'undefined' && PhasedBrainLayer.triage) {
        plan = await PhasedBrainLayer.triage(session);
      } else {
        throw new Error(
          'Triage not available: no plan_override.json found, and PhasedBrainLayer not built ' +
          'yet (Phase 5). Write a plan to .myclaudecode/phased/plan_override.json to test ' +
          'the Phase 3 loop directly.'
        );
      }
      session.phasePlan = plan.phases;
      session.triageMode = plan.mode || 'phased';
      notifyCli(session, {
        type: CLI_MESSAGE_TYPES.TRIAGE_DECIDED,
        mode: session.triageMode,
        estimate: plan.estimate,
      });

      // [ANSWER] mode: the triage response IS the deliverable. Emit it as the completion
      // summary and skip the coder tab entirely. For a task like "what is the project
      // all about?" this is the correct behavior -- the deliverable is text the user
      // reads, not a file that lives on disk.
      if (session.triageMode === 'answer') {
        const answerText = plan.answer || '(brain returned [ANSWER] but no text followed)';
        await finishTask(session, {
          type: CLI_MESSAGE_TYPES.TASK_COMPLETED,
          summary: answerText,
          stats: {
            plannerTurns: session.brainMsgCount,
            executorTurns: session.coderMsgCount,
            toolCalls: session.totalApyRuns,
            phasesAttempted: session.phasesAttempted,
            phasesSucceeded: session.phasesSucceeded,
            directEscalations: session.directEscalations,
          },
        });
        notifyCli(session, {
          type: CLI_MESSAGE_TYPES.PLANNER_THINKING,
          text:
            '(system) Both tabs kept open for follow-ups. Your next question continues ' +
            'in the same brain conversation (no bundle re-send); a follow-up code task ' +
            'will reuse the primed coder tab. Continuity is scoped to this CLI session.',
        });
        session.state = 'done';
        return;
      }

      // [RUN] mode: the brain produced a command plan. Execute it directly --
      // no coder involvement, no a.py. The plan is a sequence of shell commands,
      // optional user-confirmations, and an open target, executed in order with
      // hard-abort on any failure.
      if (session.triageMode === 'run') {
        // Phase 23 (2026-10-25): fail loudly if runPlan is missing -- this
        // catches a triage-propagation regression like the one that caused
        // "No phase plan available" on the original [RUN] run. The previous
        // && plan.runPlan fallthrough went into runPhasedMode with
        // phases:undefined, producing a confusing error far from the cause.
        if (!plan.runPlan) {
          throw new Error(
            '[RUN] mode selected but plan.runPlan is missing -- triage parser ' +
            'did not produce a run plan. This is a triage-propagation bug; the ' +
            'brainLayer.triage return object must include runPlan.'
          );
        }
        await runRunMode(session, plan.runPlan);
        return;
      }

      if (session.triageMode === 'direct' && plan.brief) {
        // Direct mode requires Phase 5's brainLayer (which owns runDirect's escalation
        // path). Guarded so Phase 3's plan-override tests never hit this branch.
        if (typeof PhasedBrainLayer !== 'undefined' && PhasedBrainLayer.runDirect) {
          await PhasedBrainLayer.runDirect(session, plan.brief);
        } else {
          throw new Error('Direct mode requires the brain layer (Phase 5).');
        }
      } else {
        await runPhasedMode(session);
      }
      session.state = 'done';

      // Completion summary reflects the actual mode. Previously always said
      // "Phased task completed: N phase(s)" even for direct mode, which was confusing.
      let completionSummary;
      if (session.triageMode === 'direct') {
        completionSummary = 'Task completed (direct mode). Tabs left open for inspection.';
      } else {
        completionSummary = `Phased task completed: ${session.completedPhases.length} phase(s). Tabs left open for inspection.`;
      }
      await finishTask(session, {
        type: CLI_MESSAGE_TYPES.TASK_COMPLETED,
        summary: completionSummary,
        stats: {
          plannerTurns: session.brainMsgCount,
          executorTurns: session.coderMsgCount,
          toolCalls: session.totalApyRuns,
          phasesAttempted: session.phasesAttempted,
          phasesSucceeded: session.phasesSucceeded,
          directEscalations: session.directEscalations,
        },
      });
    } catch (err) {
      console.error('[PhasedRunner] task error', err);
      await finishTask(session, {
        type: CLI_MESSAGE_TYPES.TASK_ERROR,
        message: err.message,
        stats: {
          plannerTurns: session.brainMsgCount,
          executorTurns: session.coderMsgCount,
          toolCalls: session.totalApyRuns,
          phasesAttempted: session.phasesAttempted,
          phasesSucceeded: session.phasesSucceeded,
          directEscalations: session.directEscalations,
        },
      });
    } finally {
      try {
        if (typeof Orchestrator !== 'undefined' && Orchestrator.sessions) {
          Orchestrator.sessions.delete(session.taskId);
        }
      } catch (_) {}
      // Tabs are NEVER auto-closed. Reason (user feedback, 2026-10-25): when triage
      // or coder produces an unexpected response, the exact DeepSeek text is the
      // primary debugging signal -- and closing the tab destroyed it before the user
      // could read it. Tabs stay open on both success and failure.
      //
      // Reuse across tasks: every task remembers its brain + coder tabs (keyed by
      // projectRoot) so the next prompt continues in the same two conversations rather
      // than opening and priming two new ones. This used to require success
      // (state === 'done'), but [DIRECT] never set that state and any failure counted,
      // so the chain broke after the second prompt and the third opened fresh tabs.
      // A failed task's conversation is still the right place for "fix what just
      // failed". Migration replaces session.*TabId, so the tab saved here is always
      // the live one; a tab the user closed is caught by the chrome.tabs.get check
      // at the next reuse.
      await saveKeptTabs(session);
    }
  }

  // Entry point called from background.js's handleCliPayload. Runs the task asynchronously
  // (background.js doesn't await -- same pattern as Orchestrator.runTask), but logs any
  // unhandled rejection so it can't silently disappear into the SW's void.
  function runTask(taskId, task, options, config, permissions, projectRoot) {
    const session = newPhasedSession(taskId, task, options, config, permissions, projectRoot);
    runPhasedTask(session).catch((err) => {
      console.error('[PhasedRunner] uncaught:', err);
    });
  }

  return {
    runTask,
    runPhasedTask,
    runPhasedMode,
    sendAndTrack,
    sendToBrain,
    writeAndRunApy,
    withTimestamp,
    newPhasedSession,
    answerPhasedQuestion,
    runBrainToolCalls,
  };
})();
