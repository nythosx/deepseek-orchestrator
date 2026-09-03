// Tab lifecycle + content-script messaging helpers for the background service worker.

const TabManager = (() => {
  // Toggle this to switch from the mock backend to the real site (readme.md step 10).
  // Requires being logged into chat.deepseek.com in this Chrome profile already — the
  // extension does not handle authentication. Unknown query params (role/taskId) are
  // harmless on the real site; it just ignores them.
  // const CHAT_BASE_URL = 'http://localhost:8080/chat';
  const CHAT_BASE_URL = 'https://chat.deepseek.com';

  function chatUrl(role, taskId) {
    const url = new URL(CHAT_BASE_URL);
    url.searchParams.set('role', role);
    url.searchParams.set('taskId', taskId);
    return url.toString();
  }

  async function createTab(role, taskId) {
    const tab = await chrome.tabs.create({ url: chatUrl(role, taskId), active: false });
    return tab.id;
  }

  const createPlannerTab = (taskId) => createTab('planner', taskId);
  const createExecutorTab = (taskId) => createTab('executor', taskId);
  // Short-lived tab used for an on-demand !SEARCH_WEB call (see orchestrator.js's
  // performWebSearch) — opened, asked one question with search toggled on, then closed.
  // Keeps ad hoc searches out of the planner/executor's own conversation history instead of
  // consuming a turn in either of their real chats.
  const createSearchTab = (taskId) => createTab('search', taskId);

  async function closeTabs(...tabIds) {
    const ids = tabIds.filter((id) => typeof id === 'number');
    if (ids.length) {
      try {
        await chrome.tabs.remove(ids);
      } catch (err) {
        console.warn('[TabManager] failed to close tabs', err.message);
      }
    }
  }

  // Bring a tab (and its window) to real OS-level focus — chrome.tabs.update({active:true})
  // alone only makes the tab the active one WITHIN its own window; if that window itself
  // isn't the OS-focused window, Chrome still throttles the tab's setTimeout-based polling
  // as a background page. chrome.windows.update({focused:true}) forces real OS-level focus,
  // which is what actually prevents that throttling. Split out of sendToTab (below) so it
  // can also be called periodically DURING a long wait, not just once at send time — see
  // refocusTab's own comment for why the one-shot version wasn't enough on its own.
  async function focusTab(tabId) {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (tab && typeof tab.windowId === 'number') {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  }

  async function sendToTab(tabId, message) {
    // Bring the tab to front first so interactions look human (stealth requirement) and so
    // its own JS isn't throttled while it types/renders our message.
    //
    // Observed live (2026-08-14), confirmed via this session's poll-tick diagnostics: a poll
    // loop that should tick every ~250ms was landing ~60 ticks across a ~180-240s wait —
    // roughly 12-16x slower than intended — which is exactly why a reply that was already
    // sitting on screen went undetected long enough to trip the inactivity timeout.
    try {
      await focusTab(tabId);
    } catch (_) {
      // tab/window may have been closed; let the sendMessage call surface the error
    }
    return chrome.tabs.sendMessage(tabId, message);
  }

  // Observed live (2026-08-14), same day as the fix above: the one-shot focus() call in
  // sendToTab wasn't enough on its own — a message is sent once, but the actual wait for
  // DeepSeek's reply (content.js's waitForAssistantSettle) can run for minutes, and real OS
  // focus drifting back to whatever the human is doing elsewhere (near-certain during a
  // long-running task) lets the tab re-throttle partway through the wait. Confirmed directly:
  // pollTickCount dropped as low as 9 across a ~237s wait (worse than the original ~60-tick
  // measurement, and this time with ZERO bubbles ever rendering) once focus had drifted away
  // again after the initial send. content.js's poll loop now calls this periodically (via a
  // 'refocusTab' runtime message, since a content script can't call chrome.windows directly)
  // for the FULL duration of the wait, not just its opening moment. Best-effort/silent by
  // design — same reasoning as sendToTab's own try/catch: a focus failure here must never be
  // treated as a real task error, it only ever makes detection slower, not wrong.
  async function refocusTab(tabId) {
    try {
      await focusTab(tabId);
    } catch (_) {
      // tab/window may have been closed, or momentarily mid-navigation; next periodic call
      // will just try again.
    }
  }

  async function pollForReady(tabId, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await chrome.tabs.sendMessage(tabId, { action: 'waitForReady' });
        if (res && res.ready) return true;
      } catch (_) {
        // content script may not be injected yet; retry
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  // Observed live: if the internet is down when a planner/executor tab is first created,
  // chrome.tabs.create navigates to a browser-level "no internet" error page instead of the
  // real site — no content script ever gets injected, so a single pollForReady pass just
  // times out and the whole task dies immediately. Retry the navigation itself, like a
  // reconnect loop, so a transient drop that clears up within ~a minute doesn't kill the
  // task outright.
  const READY_RETRY_ATTEMPTS = 10;
  const READY_RETRY_PER_ATTEMPT_MS = 15000;
  const READY_RETRY_DELAY_MS = 3000;

  // attempts used to be inferred from whether the caller's timeoutMs happened to equal the
  // READY_RETRY_PER_ATTEMPT_MS default — a fragile value-equality sentinel that broke the
  // moment a caller explicitly passed that same constant (see sendToTabResilient below,
  // which did exactly that and got the full 10-attempt reload cycle instead of the single
  // bounded check it clearly meant to ask for). Made explicit instead: a real parameter, not
  // something inferred from a magic-number coincidence.
  async function waitForReady(tabId, { timeoutMs = READY_RETRY_PER_ATTEMPT_MS, attempts = READY_RETRY_ATTEMPTS } = {}) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const ready = await pollForReady(tabId, timeoutMs);
      if (ready) return true;
      if (attempt === attempts) break;
      console.warn(`[TabManager] Tab ${tabId} not ready (attempt ${attempt}/${attempts}) — reloading and retrying.`);
      try {
        await chrome.tabs.reload(tabId);
      } catch (_) {
        // tab may have been closed; let the final throw below surface it
      }
      await new Promise((r) => setTimeout(r, READY_RETRY_DELAY_MS));
    }
    throw new Error(`Tab ${tabId} did not become ready after ${attempts} attempt(s) (internet may be down).`);
  }

  // Same "connecting... retry" pattern as waitForReady, but for every actual send —
  // prompting the model, editing a message for migration, toggling a feature, etc. A
  // network drop can happen at any of those points, not just when a tab first opens, so
  // this is the one place all of them route through instead of each call site needing its
  // own ad hoc retry logic.
  //
  // Deliberately excludes content.js's "(absolute ceiling)" timeout, even though it matches
  // /timeout/ on its face. Observed live (2026-08-10): that error means a message was
  // already given its full, generous 10-minute budget (well past the shorter inactivity
  // timeout and the network-error-banner recovery content.js tries first) and never
  // settled — retrying it re-sends the same content (duplicating it in the chat) and waits
  // through ANOTHER full 10-minute budget, up to SEND_RETRY_ATTEMPTS times. That's not
  // recovery, it's a ~100-minute silent hang before the task ever fails. A real network
  // blip resolves via the shorter "(no progress)" inactivity path or the network-banner
  // path long before hitting the absolute ceiling, so there's nothing left for a retry here
  // to plausibly fix.
  // "stopped mid-generation" (content.js's DeepThink Stopped-badge detection) is a clean,
  // fast, in-the-moment catch — unlike the absolute-ceiling case excluded below, it hasn't
  // already sat through a full timeout budget, so retrying it here is cheap and worthwhile.
  // "captcha" is deliberately NOT included — see NOT_RETRYABLE_RE.
  // "message channel closed" is Chrome's own error when a chrome.tabs.sendMessage /
  // chrome.runtime.onMessage listener promised an async response (returned true) but never
  // delivered one before the port was torn down — classically an MV3 service worker getting
  // suspended/restarted mid-flight (they're ephemeral; a multi-minute wait for a real
  // response, which this codebase routinely has, is well past Chrome's idle-suspend window).
  // Observed live (2026-08-14/15): this killed a whole task outright on its FIRST occurrence
  // (no retry at all, unlike every other transient failure above) because it matched none of
  // the existing keywords. It's exactly the same class of "resend and it'll probably just
  // work" transient failure as a network blip — the tab/page itself is still fine, only the
  // one in-flight message got orphaned — so it gets the same retry treatment.
  const SEND_RETRYABLE_RE = /network|connection|did not become ready|timed out|timeout|stopped mid-generation|message channel closed/i;
  // A CAPTCHA needs a real human to solve it; resending the same message can't fix that, so
  // it gets the same "don't bother retrying" treatment as the absolute-ceiling case. A
  // length-limit-reached chat is permanently full — resending is equally pointless, it needs
  // orchestrator.js's sendAndTrack to catch it and migrate to a fresh tab instead (it doesn't
  // match SEND_RETRYABLE_RE's keywords anyway, but listed explicitly here so that stays true
  // even if that pattern is ever broadened).
  const NOT_RETRYABLE_RE = /absolute ceiling|captcha|length limit reached/i;
  const SEND_RETRY_ATTEMPTS = 10;
  const SEND_RETRY_DELAY_MS = 3000;

  function isRetryableSendError(message) {
    return SEND_RETRYABLE_RE.test(message) && !NOT_RETRYABLE_RE.test(message);
  }

  // onAttempt (optional): called after EVERY attempt (success or failure) with
  // { attempt, attempts, elapsedMs, error, diagnostics }. Exists so a caller with a CLI connection
  // (orchestrator.js) can surface per-attempt timing — previously a slow/failing send only
  // ever showed up as one opaque final error with no visibility into how many attempts were
  // made or how long each one individually took (observed live 2026-08-14: a single failed
  // turn burned ~31 minutes across its retries with nothing in the log to show why). tabs.js
  // itself has no CLI connection, hence the callback rather than sending anything directly.
  async function sendToTabResilient(
    tabId,
    message,
    { attempts = SEND_RETRY_ATTEMPTS, delayMs = SEND_RETRY_DELAY_MS, onAttempt } = {}
  ) {
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const attemptStartedAt = Date.now();
      try {
        const res = await sendToTab(tabId, message);
        if (res && res.error && isRetryableSendError(res.error)) {
          lastErr = new Error(res.error);
          // res.diagnostics: see content.js's rejectWithDiagnostics / the onMessage catch
          // blocks that now forward it — without this, a retryable failure's diagnostics
          // (poll tick count, whether a new bubble was ever recognized, etc.) never left
          // content.js at all.
          lastErr.diagnostics = res.diagnostics || null;
        } else {
          if (onAttempt) onAttempt({ attempt, attempts, elapsedMs: Date.now() - attemptStartedAt, error: null, diagnostics: (res && res.diagnostics) || null });
          return res;
        }
      } catch (err) {
        if (!isRetryableSendError((err && err.message) || '')) {
          if (onAttempt) onAttempt({ attempt, attempts, elapsedMs: Date.now() - attemptStartedAt, error: err.message, diagnostics: err.diagnostics || null });
          throw err;
        }
        lastErr = err;
      }
      if (onAttempt) onAttempt({ attempt, attempts, elapsedMs: Date.now() - attemptStartedAt, error: lastErr.message, diagnostics: lastErr.diagnostics || null });
      if (attempt === attempts) break;
      console.warn(
        `[TabManager] Retryable failure sending to tab ${tabId} (attempt ${attempt}/${attempts}): ${lastErr.message}`
      );
      try {
        // Single bounded check, not the full reload-retry saga — this loop is ALREADY the
        // retry (attempts of sendToTabResilient itself); if the tab is actually fine (e.g.
        // the error was a transient send hiccup) this resolves quickly, and if it's not, the
        // outer loop above will call this again on the next attempt anyway. Explicitly
        // attempts: 1 here, not just omitting the option, since omitting it would silently
        // fall back to the multi-attempt default — exactly the bug this fixed (see
        // waitForReady's own comment).
        await waitForReady(tabId, { attempts: 1 });
      } catch (_) {
        // still not back — fall through to the plain delay and try the send again anyway.
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw lastErr;
  }

  // Selector self-test canary (see content.js's 'checkSelectors' handler) — best-effort:
  // any failure here (tab gone, content script not injected) is swallowed and treated as
  // "nothing to report" rather than surfaced as a real task error, since this is purely an
  // early-warning check, not something the task should ever fail over.
  async function checkSelectors(tabId) {
    try {
      const res = await sendToTab(tabId, { action: 'checkSelectors' });
      return (res && res.missing) || [];
    } catch (_) {
      return [];
    }
  }

  return {
    chatUrl,
    createPlannerTab,
    createExecutorTab,
    createSearchTab,
    closeTabs,
    sendToTab,
    sendToTabResilient,
    refocusTab,
    waitForReady,
    checkSelectors,
  };
})();
