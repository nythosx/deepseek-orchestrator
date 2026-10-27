// Disk-based migration for phased mode (spec section 4.1 + Addendum 2 Part K). Bypasses
// editMessage entirely -- the fragile self-summary mechanism that caused the v1 migration
// loop (see claude-response.md / the 2026-08-15 incidents) is not used anywhere here.
//
// Two prompt shapes:
//   - Coder tab   -> starter prompt (spec A.7): task + phase plan + recent log + current
//                    a.py + traceback + targeted-or-full bundle + protocol reminders.
//   - Brain tab   -> brain recap (Addendum 2 Part K): task + current phase plan + phase
//                    status + attention tail + last 10 brain responses verbatim + why the
//                    migration happened. Brain-log.jsonl is the source of truth.
//
// Rate-limit handling (spec Addendum 2 Part J): back off (config.rateLimitBackoffMs) then
// migrate. The spec's full "retry same tab between waits" is skipped -- sendToTabResilient
// has already exhausted its own 10-retry budget by the time we're called, so an extra
// same-tab attempt adds little value; the backoff window exists to give DeepSeek's servers
// time to un-throttle before we land on the fresh tab.
//
// Known limitation: sleep() uses setTimeout, which does NOT keep the MV3 service worker
// alive on its own. A 3-minute backoff (spec default) may be interrupted by Chrome
// suspending the SW. Phase 7's e2e test exercises this; if it fails in practice we'll
// either shorten the schedule or use chrome.alarms (needs manifest "alarms" permission).
const PhasedMigration = (() => {
  const DEFAULT_BACKOFF_MS = [30000, 60000, 120000];

  function notifyCli(session, payload) {
    if (session.cancelled) return;
    NativeBridge.sendToCli({ taskId: session.taskId, ...payload });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function toForwardSlash(p) {
    return String(p || '').replace(/\\/g, '/');
  }

  // --- recap / starter builders --------------------------------------------

  async function buildBrainRecap(session, reason) {
    const parts = [];
    const push = (label, body) => parts.push(`=== ${label} ===\n${body || '(none)'}\n`);

    const notice = (typeof TIMESTAMP_NOTICE !== 'undefined') ? TIMESTAMP_NOTICE : '';
    parts.push(
      'You are the senior engineer for this phased build. You are picking up after your\n' +
        'previous tab became unavailable. This message is a RECAP of everything you need —\n' +
        'you have no conversation history from the old tab.\n\n' +
        (notice ? notice + '\n\n' : '')
    );

    push('TASK', session.taskDescription || '');

    let currentPlan = '(no plan recorded in brain-log)';
    try {
      const triageRaw = await PhasedBrainLog.readMostRecentTriage(session);
      if (triageRaw) currentPlan = triageRaw;
    } catch (_) {}
    push('CURRENT PHASE PLAN (verbatim from your most recent triage)', currentPlan);

    let status = '';
    const plan = session.phasePlan || [];
    for (let i = 0; i < plan.length; i++) {
      const ph = plan[i];
      if (i < (session.currentPhaseIndex || 0)) status += `✓ phase ${i + 1} (${ph.name})\n`;
      else if (i === (session.currentPhaseIndex || 0)) status += `▶ phase ${i + 1} (${ph.name}) — IN PROGRESS\n`;
      else status += `  phase ${i + 1} (${ph.name}) — pending\n`;
    }
    push('PHASE STATUS', status || '(no phase plan set)');

    let attentionTail = '(no attention items)';
    try {
      const items = await PhasedLogStore.readAttention(session, 10);
      if (items.length) {
        attentionTail = items
          .map((a) => `[${a.severity || '?'}] ${a.kind || '?'}: ${(a.detail || '').slice(0, 300)}`)
          .join('\n')
          .slice(-3000);
      }
    } catch (_) {}
    push('ATTENTION ITEMS (undismissed)', attentionTail);

    let recentBrain = '(no recent responses)';
    try {
      const entries = await PhasedBrainLog.readRecent(session, 10);
      const lines = [];
      let budget = 15000;
      for (const e of entries) {
        if (budget <= 0) break;
        const snippet = (e.raw || '').slice(0, Math.min(2000, budget));
        lines.push(`--- ${e.kind || '?'} @ ${new Date(e.ts).toISOString()} ---\n${snippet}`);
        budget -= snippet.length;
      }
      if (lines.length) recentBrain = lines.join('\n\n');
    } catch (_) {}
    push('YOUR RECENT RESPONSES (verbatim, most recent last)', recentBrain);

    push('WHY THIS MIGRATION HAPPENED', reason || 'unknown');

    parts.push(
      'Reply [CONTINUE] to acknowledge and resume the phase loop. If the recap reveals the\n' +
        'phase plan needs adjustment, reply [REPLAN] followed by a new plan. Do not restate\n' +
        'this message. Do not explain. Just decide.\n'
    );

    return parts.join('\n');
  }

  async function buildCoderStarter(session, reason) {
    const parts = [];
    const push = (label, body) => parts.push(`=== ${label} ===\n${body || '(none)'}\n`);

    const primer =
      (typeof APY_CODER_PROMPT !== 'undefined')
        ? APY_CODER_PROMPT
        : 'You are a coding agent producing ONE Python script. Output exactly one ```python block.';

    parts.push(primer + '\n');
    parts.push(
      'You are picking up a phased build in progress after the previous DeepSeek tab became\n' +
        'unavailable. You have NO conversation history from it. Everything you need is here.\n\n'
    );

    push('TASK', session.taskDescription || '');

    let status = '';
    const plan = session.phasePlan || [];
    for (let i = 0; i < plan.length; i++) {
      const ph = plan[i];
      if (i < (session.currentPhaseIndex || 0)) status += `✓ phase ${i + 1} (${ph.name})\n`;
      else if (i === (session.currentPhaseIndex || 0)) status += `▶ phase ${i + 1} (${ph.name}) — CURRENT\n`;
      else status += `  phase ${i + 1} (${ph.name}) — pending\n`;
    }
    push('PHASE PLAN', status || '(no phase plan set)');

    let logTail = '(no recent log)';
    try {
      const entries = await PhasedLogStore.readLog(session, 5);
      if (entries.length) {
        logTail = entries
          .map((e) => `[${e.phase || '?'} attempt ${e.attempt || '?'}] exit=${e.exitCode} marker=${e.successMarker}`)
          .join('\n')
          .slice(-2000);
      }
    } catch (_) {}
    push('RECENT LOG (last 5 phases)', logTail);

    push('WHY THE PREVIOUS TAB ENDED', reason || 'unknown');

    // Current a.py + traceback
    let apyContent = '(no a.py yet)';
    const phaseNum = (session.currentPhaseIndex || 0) + 1;
    const prefix = `phase_${String(phaseNum).padStart(2, '0')}_`;
    try {
      const ls = await NativeBridge.execTool(session.taskId, TOOLS.LS, {
        path: '.myclaudecode/phased/scripts',
      });
      if (typeof ls === 'string' && ls.trim()) {
        const matches = ls
          .split('\n')
          .filter((line) => line.includes(prefix) && line.endsWith('.py'));
        if (matches.length) {
          const lastName = matches[matches.length - 1].split(/\s+/).pop();
          const text = await NativeBridge.execTool(session.taskId, TOOLS.READ_FILE, {
            path: `.myclaudecode/phased/scripts/${lastName}`,
          });
          if (typeof text === 'string') apyContent = text;
        }
      }
    } catch (_) {}
    push('CURRENT a.py', apyContent);
    push('TRACEBACK FROM LAST RUN', (session.lastTraceback || '').slice(0, 4000) || '(none)');

    // Bundle: targeted (or full if targeted is unexpectedly large)
    let bundle = '';
    let bundleMode = 'targeted';
    try {
      if (session.compiledBundle) {
        bundle = session.compiledBundle;
        bundleMode = 'compiled';
      } else if (typeof PhasedBundleBuilder !== 'undefined') {
        bundle = await PhasedBundleBuilder.buildTargeted(session);
        if (bundle.length > PhasedBundleBuilder.BUNDLE_CHAR_LIMIT) {
          const full = await PhasedBundleBuilder.buildFull(session);
          bundle = full.content;
          bundleMode = 'full';
        }
      } else {
        bundle = '(bundle builder not available)';
      }
    } catch (err) {
      bundle = `(bundle build failed: ${err.message})`;
      bundleMode = 'failed';
    }
    push(`PROJECT FILES AS THEY EXIST NOW (${bundleMode} bundle)`, bundle);

    push(
      'PROTOCOL REMINDERS',
      '- Output exactly ONE ```python code block containing the full fixed a.py.\n' +
        '- No comments. Idempotent. No backups. No git commits.\n' +
        '- Print __PHASE_WROTE__ <paths> before running phase tests.\n' +
        '- Print __PHASE_SUCCESS__ on its own line ONLY if all phase tests pass.\n' +
        `- Do not re-run completed phases. Fix the current phase only.`
    );

    session._lastBundleMode = bundleMode;
    session._lastBundleChars = bundle.length;
    return parts.join('\n');
  }

  // --- migrate --------------------------------------------------------------

  async function migrate(session, role, reason, pendingText) {
    if (session.cancelled) throw new Error('Task cancelled.');
    const isBrain = role === 'planner';

    // Brain migration cap (single-profile, v1): 2 attempts per role. Prevents an infinite
    // rate-limit loop when the account is genuinely throttled -- spec E3 (Addendum 3) caps
    // cross-profile hops at 2; single-profile rate limits are usually transient, so 2 is
    // the analogous ceiling here. The user sees a clear message and can retry later.
    session.migrationCounts = session.migrationCounts || { planner: 0, executor: 0 };
    session.migrationCounts[role]++;
    if (session.migrationCounts[role] > 2) {
      throw new Error(
        `DeepSeek rate limit persists across ${session.migrationCounts[role]} migrations of ` +
          `the ${role} tab. Try again in 5-15 minutes, or use a different Chrome profile / ` +
          `account for this task.`
      );
    }

    // Build prompt BEFORE closing the old tab (need to read a.py etc. while tab IDs still
    // point at the still-alive tabs; also guards against a build failure leaving us with no
    // tab at all).
    const base = isBrain
      ? await buildBrainRecap(session, reason)
      : await buildCoderStarter(session, reason);
    const prompt = pendingText
      ? base + '\n\n=== THE MESSAGE YOU MUST ANSWER NOW (it was meant for the previous tab) ===\n' + pendingText
      : base;

    // Close old tab, open new
    const oldTabKey = isBrain ? 'brainTabId' : 'coderTabId';
    const oldTabId = session[oldTabKey];
    if (oldTabId != null) {
      try { await TabManager.closeTabs(oldTabId); } catch (_) {}
    }
    const newTabId = isBrain
      ? await TabManager.createPlannerTab(session.taskId)
      : await TabManager.createExecutorTab(session.taskId);
    await TabManager.waitForReady(newTabId);
    session[oldTabKey] = newTabId;

    // Reset counters for the migrated role
    if (isBrain) {
      session.brainMsgCount = 0;
      session.brainCharCount = 0;
    } else {
      session.coderMsgCount = 0;
      session.coderCharCount = 0;
    }
    session.successStreak = 0;

    notifyCli(session, {
      type: isBrain ? CLI_MESSAGE_TYPES.BRAIN_MIGRATED : CLI_MESSAGE_TYPES.MIGRATED,
      role,
      reason,
      mode: isBrain ? 'recap' : (session._lastBundleMode || 'targeted'),
      bundleChars: isBrain ? prompt.length : (session._lastBundleChars || prompt.length),
    });

    // Send the prompt. Deliberately direct sendToTabResilient (not sendAndTrack) so a
    // fresh-tab failure can't infinitely recurse into migrate() -- the caller sees the
    // error and can decide (retry, fail, escalate). The next REGULAR turn on this tab
    // will go through sendAndTrack normally and can migrate again if the new tab also
    // rate-limits.
    const timestamped = PhasedRunner.withTimestamp(prompt, session);
    let res;
    try {
      res = await TabManager.sendToTabResilient(newTabId, {
        action: 'typeAndSend',
        text: timestamped,
        instant: true,
      });
    } catch (err) {
      throw new Error(`Post-migration send to ${role} failed: ${err.message}`);
    }
    if (res && res.error) {
      throw new Error(`Post-migration send to ${role} failed: ${res.error}`);
    }

    // Update counters for the migrated role
    if (isBrain) {
      session.brainMsgCount = 1;
      session.brainCharCount = timestamped.length + ((res && res.text && res.text.length) || 0);
    } else {
      session.coderMsgCount = 1;
      session.coderCharCount = timestamped.length + ((res && res.text && res.text.length) || 0);
    }
    session.totalDeepSeekTurns++;
    // Every brain response during migration is logged, matching sendAndTrack's behavior.
    if (isBrain && typeof PhasedBrainLog !== 'undefined' && PhasedBrainLog.append) {
      await PhasedBrainLog.append(session, 'migration_response', (res && res.text) || '').catch(() => {});
    }

    return (res && res.text) || '';
  }

  // --- rate limit -----------------------------------------------------------

  // Single-account friendly: no migration (a fresh tab on the same account is just as
  // throttled). Wait rateLimitRetryMs (default 10 min) with a CLI countdown, then the
  // caller resends the same message on the SAME tab. Gives up after rateLimitMaxRetries.
  const DEFAULT_RETRY_MS = 10 * 60 * 1000;
  const DEFAULT_MAX_RETRIES = 6;

  async function waitOutRateLimit(session, role, error, attempt) {
    const cfg = session.phasedConfig || {};
    const waitMs = cfg.rateLimitRetryMs || DEFAULT_RETRY_MS;
    const maxRetries = cfg.rateLimitMaxRetries || DEFAULT_MAX_RETRIES;
    if (attempt > maxRetries) {
      throw new Error(
        `DeepSeek is still rate limiting the ${role === 'planner' ? 'brain' : 'coder'} tab after ` +
          `${maxRetries} retries (${Math.round((maxRetries * waitMs) / 60000)} min). Try again later.`
      );
    }
    notifyCli(session, {
      type: CLI_MESSAGE_TYPES.RATE_LIMIT_DETECTED,
      role,
      error,
      attempt,
      maxRetries,
      retryAt: Date.now() + waitMs,
    });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (session.cancelled) throw new Error('Task cancelled.');
      await sleep(Math.min(5000, deadline - Date.now()));
    }
  }

  async function handleRateLimit(session, role, error) {
    notifyCli(session, {
      type: CLI_MESSAGE_TYPES.RATE_LIMIT_DETECTED,
      role,
      error,
    });
    // Back off then migrate. See file header for why the "retry same tab between waits"
    // portion of the spec's flow is skipped.
    const schedule =
      (session.phasedConfig && session.phasedConfig.rateLimitBackoffMs) || DEFAULT_BACKOFF_MS;
    for (const waitMs of schedule) {
      if (session.cancelled) throw new Error('Task cancelled.');
      notifyCli(session, { type: CLI_MESSAGE_TYPES.THINKING_STARTED, role });
      await sleep(waitMs);
    }
    return migrate(session, role, 'rate_limit');
  }

  return { migrate, handleRateLimit, waitOutRateLimit, buildBrainRecap, buildCoderStarter };
})();
