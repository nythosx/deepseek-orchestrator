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

  // "Could not establish connection. Receiving end does not exist." — nothing in the tab is
  // listening. Three real causes: the extension was reloaded/updated (the old content.js is
  // orphaned and can't receive from the new service worker), Chrome's Memory Saver discarded
  // the idle tab, or the page navigated and content.js hasn't loaded yet. None of them are
  // fixed by just waiting, which is all the generic retry in sendToTabResilient does.
  const NO_RECEIVER_RE = /receiving end does not exist|could not establish connection/i;

  // Gets a live content.js into the tab without losing the chat: discarded tabs have to be
  // reloaded (no document to inject into), everything else gets content.js injected in
  // place — content.js's own instance guard makes that a no-op if a live copy is already
  // there. streamBridge.js is deliberately not re-injected: it patches window.fetch in the
  // MAIN world and would double-patch, and webRequest already covers its signal.
  async function recoverContentScript(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.discarded || tab.status === 'unloaded') {
      console.warn(`[TabManager] Tab ${tabId} was discarded — reloading.`);
      await chrome.tabs.reload(tabId);
    } else {
      console.warn(`[TabManager] No content script in tab ${tabId} — re-injecting.`);
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      } catch (err) {
        console.warn(`[TabManager] Injection into tab ${tabId} failed (${err.message}) — reloading.`);
        await chrome.tabs.reload(tabId);
      }
    }
    return pollForReady(tabId, READY_RETRY_PER_ATTEMPT_MS);
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
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      if (!NO_RECEIVER_RE.test((err && err.message) || '')) throw err;
      // The message was never delivered, so resending it once can't duplicate anything
      // in the chat.
      if (!(await recoverContentScript(tabId).catch(() => false))) throw err;
      return chrome.tabs.sendMessage(tabId, message);
    }
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
    let lastErr = null;
    let injected = false;
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await chrome.tabs.sendMessage(tabId, { action: 'waitForReady' });
        if (res && res.ready) return true;
      } catch (err) {
        lastErr = err.message;
        // content script may not be injected yet; retry. If the page has finished loading
        // and there's still no receiver, it's not coming on its own (orphaned after an
        // extension reload) — inject once rather than waiting out the full timeout.
        if (!injected && NO_RECEIVER_RE.test(lastErr) && Date.now() - start > 3000) {
          injected = true;
          try {
            const tab = await chrome.tabs.get(tabId);
            if (tab.status === 'complete' && !tab.discarded) {
              await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
            }
          } catch (_) {
            // not injectable (error page, closed tab) — waitForReady's reload handles it
          }
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (lastErr) {
      console.warn(`[TabManager] pollForReady failed after ${timeoutMs}ms: ${lastErr}`);
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
      } catch (waitErr) {
        console.warn(`[TabManager] Tab ${tabId} still not ready before retry: ${waitErr.message}`);
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

  // Opens a URL in a new tab and records everything the page logs from the very first
  // byte: console.* calls of every level, uncaught exceptions and rejections, failed and
  // 4xx/5xx requests, and whether the page loaded at all. Uses chrome.debugger (CDP) and
  // attaches BEFORE navigating -- the legacy path below injected a listener ~3s after load,
  // which missed load-time errors (failed module imports, 404'd JSON) and needed a host
  // permission per origin. The tab is left open for the user; only the debugger detaches.
  const INSPECT_LOAD_TIMEOUT_MS = 15000;
  const INSPECT_SETTLE_MS = 3000;
  const INSPECT_MAX_LOGS = 200;

  function remoteObjectText(o) {
    if (!o) return '';
    if (o.type === 'string') return o.value;
    if ('value' in o) return JSON.stringify(o.value);
    return o.unserializableValue || o.description || o.type;
  }

  function frameLocation(stackTrace, url, line) {
    const f = stackTrace && stackTrace.callFrames && stackTrace.callFrames[0];
    const u = (f && f.url) || url;
    const l = f ? f.lineNumber : line;
    if (!u) return '';
    return ` (${u.replace(/^https?:\/\/[^/]+/, '')}${typeof l === 'number' ? ':' + (l + 1) : ''})`;
  }

  async function inspectTab(url) {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
    const target = { tabId: tab.id };
    try {
      await chrome.debugger.attach(target, '1.3');
    } catch (err) {
      console.warn('[TabManager] inspectTab: debugger attach failed, using legacy inspector:', err.message);
      await chrome.tabs.remove(tab.id).catch(() => {});
      const legacy = await inspectTabLegacy(url);
      return { ...legacy, logs: [], failedRequests: [], loadError: null, pageInfo: null };
    }

    const logs = []; // { level, text }
    const failedRequests = [];
    const requestUrls = new Map();
    let loaded = false;
    const push = (level, text) => {
      if (logs.length < INSPECT_MAX_LOGS) logs.push({ level, text: String(text).slice(0, 1000) });
    };
    const onEvent = (source, method, params) => {
      if (source.tabId !== tab.id) return;
      if (method === 'Runtime.consoleAPICalled') {
        const level = params.type === 'warning' ? 'warn' : params.type === 'assert' ? 'error' : params.type;
        push(level, (params.args || []).map(remoteObjectText).join(' ') + frameLocation(params.stackTrace));
      } else if (method === 'Runtime.exceptionThrown') {
        const d = params.exceptionDetails || {};
        const text = (d.exception && d.exception.description) || d.text || 'Uncaught exception';
        push('error', text.split('\n').slice(0, 4).join('\n') + frameLocation(d.stackTrace, d.url, d.lineNumber));
      } else if (method === 'Log.entryAdded') {
        const e = params.entry || {};
        // network-sourced entries duplicate failedRequests below
        if (e.source === 'network') return;
        if (e.level === 'error' || e.level === 'warning') {
          push(e.level === 'warning' ? 'warn' : 'error', e.text + frameLocation(null, e.url, e.lineNumber));
        }
      } else if (method === 'Network.requestWillBeSent') {
        requestUrls.set(params.requestId, params.request && params.request.url);
      } else if (method === 'Network.responseReceived') {
        const r = params.response || {};
        if (r.status >= 400 && !/\/favicon\.ico$/.test(r.url)) failedRequests.push(`HTTP ${r.status} ${r.url}`);
      } else if (method === 'Network.loadingFailed') {
        if (params.canceled) return;
        const u = requestUrls.get(params.requestId) || '(unknown url)';
        if (!/\/favicon\.ico$/.test(u)) {
          failedRequests.push(`${params.blockedReason ? 'BLOCKED ' + params.blockedReason : params.errorText} ${u}`);
        }
      } else if (method === 'Page.loadEventFired') {
        loaded = true;
      }
    };
    chrome.debugger.onEvent.addListener(onEvent);

    let loadError = null;
    let pageInfo = null;
    let screenshotBase64 = null;
    try {
      const send = (m, p) => chrome.debugger.sendCommand(target, m, p || {});
      await send('Runtime.enable');
      await send('Log.enable');
      await send('Network.enable');
      await send('Page.enable');
      const nav = await send('Page.navigate', { url });
      if (nav && nav.errorText) loadError = nav.errorText;
      const start = Date.now();
      while (!loadError && !loaded && Date.now() - start < INSPECT_LOAD_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!loadError && !loaded) loadError = `load event did not fire within ${INSPECT_LOAD_TIMEOUT_MS / 1000}s`;
      // Let async startup (module graphs, fetches, first frames) run and log.
      await new Promise((r) => setTimeout(r, INSPECT_SETTLE_MS));
      if (!nav || !nav.errorText) {
        try {
          const ev = await send('Runtime.evaluate', {
            returnByValue: true,
            expression: `({
              title: document.title,
              readyState: document.readyState,
              text: (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400),
              canvases: document.querySelectorAll('canvas').length,
              elements: document.querySelectorAll('body *').length,
            })`,
          });
          pageInfo = ev && ev.result ? ev.result.value : null;
        } catch (_) {}
      }
      try {
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        screenshotBase64 = shot && shot.data;
      } catch (_) {}
    } catch (err) {
      loadError = loadError || 'inspector error: ' + err.message;
    } finally {
      chrome.debugger.onEvent.removeListener(onEvent);
      chrome.debugger.detach(target).catch(() => {});
    }

    // Back-compat: `errors` is what the !INSPECT_TAB callers and older code read.
    const errors = logs.filter((l) => l.level === 'error').map((l) => l.text).concat(failedRequests);
    if (loadError) errors.unshift(`Page failed to load: ${loadError}`);
    return { errors, logs, failedRequests, loadError, pageInfo, screenshotBase64 };
  }

  async function inspectTabLegacy(url) {
    // If it's a relative file path (like 'vanilla.html'), convert it to a file:// URL
    let finalUrl = url;
    if (!/^https?:\/\//i.test(url) && !url.startsWith('file://')) {
      if (url.endsWith('.html')) {
        // Best-effort: assume it's a local file. The caller should really pass an absolute URL or file path.
        finalUrl = url; // Fallback
      }
    }
    const tab = await chrome.tabs.create({ url: finalUrl, active: true });
    await new Promise(r => setTimeout(r, 3000));
    let errors = [];
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          return new Promise((resolve) => {
            const errs = [];
            const handler = (e) => errs.push(e.message || String(e));
            const rejHandler = (e) => errs.push('Unhandled Rejection: ' + String(e.reason));
            window.addEventListener('error', handler);
            window.addEventListener('unhandledrejection', rejHandler);
            setTimeout(() => {
              window.removeEventListener('error', handler);
              window.removeEventListener('unhandledrejection', rejHandler);
              resolve(errs);
            }, 2000);
          });
        }
      });
      errors = result || [];
    } catch (err) {
      errors = ['Failed to inject error listener: ' + err.message];
    }
    
    let screenshotBase64 = null;
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      if (dataUrl) screenshotBase64 = dataUrl.split(',')[1];
    } catch (_) {}
    
    return { errors, screenshotBase64 };
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
    inspectTab,
  };
})();
