// MV3 service worker. Classic script (not a module) so importScripts shares one global scope.
importScripts(
  'lib/protocol.js',
  'lib/nativeBridge.js',
  'lib/tabs.js',
  'lib/trustedInput.js',
  'lib/toolCalls.js',
  'lib/orchestrator.js',
  'lib/phased/loader.js'
);

function handleCliPayload(payload) {
  if (!payload || !payload.type) return;

  if (payload.type === CLI_MESSAGE_TYPES.RUN_TASK) {
    const options = payload.options || {};
    // Guarded phased dispatch — see lib/phased/loader.js. PhasedRunner exists only once
    // Phase 3 has run; until then, --phased produces a clear, single error rather than a
    // silent fallback, so it's obvious whether the build was actually completed. Legacy
    // mode is unaffected — its dispatch below is byte-for-byte the original.
    if (options.phased === true) {
      if (typeof PhasedRunner === 'undefined') {
        NativeBridge.sendToCli({
          type: CLI_MESSAGE_TYPES.TASK_ERROR,
          taskId: payload.taskId,
          message:
            'Phased mode is enabled but the phased runner is not yet built (phase 3 of the phased-mode rollout). Use --legacy to run legacy mode, or complete the phased build.',
        });
        return;
      }
      PhasedRunner.runTask(
        payload.taskId,
        payload.task,
        options,
        payload.config || {},
        payload.permissions || {},
        payload.projectRoot
      );
      return;
    }
    Orchestrator.runTask(
      payload.taskId,
      payload.task,
      options,
      payload.config || {},
      payload.permissions || {},
      payload.projectRoot
    );
    return;
  }

  if (payload.type === CLI_MESSAGE_TYPES.CLOSE_SESSION) {
    Orchestrator.closeSession(payload.projectRoot).then((result) => {
      NativeBridge.sendToCli({
        type: CLI_MESSAGE_TYPES.SESSION_CLOSED,
        taskId: payload.taskId,
        ...result,
      });
    });
    return;
  }

  if (payload.type === CLI_MESSAGE_TYPES.ANSWER_USER_QUESTION) {
    // Resolve on BOTH the legacy orchestrator's askUser and phased mode's own
    // pending-questions map (Phase 22 -- [RUN] mode and any other phased caller
    // uses PhasedRunner.phasedAskUser). Whichever side created this questionId
    // consumes it; the other is a no-op.
    try { Orchestrator.answerQuestion(payload.questionId, payload.answer); } catch (_) {}
    try {
      if (typeof PhasedRunner !== 'undefined' && PhasedRunner.answerPhasedQuestion) {
        PhasedRunner.answerPhasedQuestion(payload.questionId, payload.answer);
      }
    } catch (_) {}
    return;
  }

  if (payload.type === CLI_MESSAGE_TYPES.CANCEL_TASK) {
    Orchestrator.cancelTask(payload.taskId);
    return;
  }

  // approve_tool responses are consumed host-side for pending SHELL approvals;
  // nothing for the orchestrator to do here.
}

NativeBridge.setOnCliPayload(handleCliPayload);
NativeBridge.setOnDisconnect(() => {
  console.warn('[background] native host connection lost; NativeBridge is reconnecting.');
});

// connect() is idempotent (no-op if a port is already open), so it's safe to call
// from every event that might be this service worker's first wake-up.
chrome.runtime.onStartup.addListener(() => NativeBridge.connect());
chrome.runtime.onInstalled.addListener(() => NativeBridge.connect());
NativeBridge.connect();

// profileId: generated per-profile on first install, stored in chrome.storage.local, sent
// to the native host once we have it. The host includes it in every HELLO_ACK, and the
// CLI's WebSocket server attaches it to the connection (cli/lib/server.js). In v1 every
// profile's ID equals its own — cross-profile migration (v2) is what makes it useful to
// have the distinction. The first HELLO_ACK after a fresh start may carry null, which
// server.js tolerates — reconnect gets the ID through.
async function ensureProfileId() {
  try {
    const stored = await chrome.storage.local.get('profileId');
    if (stored && stored.profileId) return stored.profileId;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ profileId: id });
    return id;
  } catch (err) {
    console.warn('[background] profileId bootstrap failed:', err);
    return null;
  }
}
ensureProfileId()
  .then((id) => {
    if (id) NativeBridge.sendProfileId(id);
  })
  .catch((err) => console.warn('[background] profileId send failed:', err));

// Ground-truth "DeepSeek finished generating" signal for content.js's waitForAssistantSettle
// (see its 'streamCompleted' message handler). Originally attempted as a page-context
// window.fetch patch (extension/lib/streamBridge.js) — confirmed live against the real site
// that this doesn't work: DeepSeek's actual chat-completion request never triggers a
// page-level fetch patch at all, most likely because it's issued from a Worker or Service
// Worker context (which has its own independent `self`, not `window`) rather than the page's
// main JS realm. chrome.webRequest sees every network request for the tab at the browser's
// network-stack level regardless of which realm issued it, so it isn't subject to that blind
// spot. onCompleted specifically (not onResponseStarted) fires only once the full response
// body has been received — exactly "the stream is done", not just "it started".
const DEEPSEEK_COMPLETION_URL_PATTERN = '*://chat.deepseek.com/api/v*/chat/completion*';

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return; // not associated with a tab (e.g. a background/SW-only request)
    chrome.tabs.sendMessage(details.tabId, { action: 'streamCompleted', url: details.url, ts: Date.now() })
      // The content script may not have a listener registered yet (tab mid-navigation) —
      // this is just a speed optimization on top of the DOM-based fallback, so a missed
      // delivery here is not an error worth surfacing, just a no-op.
      .catch(() => {});
  },
  { urls: [DEEPSEEK_COMPLETION_URL_PATTERN] }
);

// Rate-limit detection, same pattern as the completion listener above: read at the network
// layer rather than scraping DOM for a banner whose exact markup we don't have captured.
// 429/503 covers the standard "too many requests" and "temporarily unavailable" responses;
// onErrorOccurred catches the transport-level equivalents. Both forward to the tab's
// content script as 'rateLimitDetected' — content.js's waitForAssistantSettle rejects with
// a RATE_LIMIT: error that orchestrator.js recognizes (see its migratable-error handling),
// which triggers the backoff-then-migrate path rather than a plain task error.
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.statusCode === 429 || details.statusCode === 503) {
      chrome.tabs.sendMessage(details.tabId, {
        action: 'rateLimitDetected',
        statusCode: details.statusCode,
        url: details.url,
        ts: Date.now(),
      }).catch(() => {});
    }
  },
  { urls: [DEEPSEEK_COMPLETION_URL_PATTERN] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.error === 'net::ERR_TOO_MANY_REQUESTS' || details.error === 'net::ERR_RATE_LIMIT') {
      chrome.tabs.sendMessage(details.tabId, {
        action: 'rateLimitDetected',
        error: details.error,
        url: details.url,
        ts: Date.now(),
      }).catch(() => {});
    }
  },
  { urls: [DEEPSEEK_COMPLETION_URL_PATTERN] }
);

// See TabManager.refocusTab's comment (extension/lib/tabs.js) — content.js's poll loop
// can't call chrome.windows itself (content scripts don't get that API), so it asks the
// background page to do it periodically for the whole duration of a long wait, not just
// once at send time.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'refocusTab' && sender.tab && typeof sender.tab.id === 'number') {
    TabManager.refocusTab(sender.tab.id).then(() => sendResponse({ ok: true }));
    return true;
  }
  // See lib/trustedInput.js — content.js can only produce isTrusted:false events, which
  // DeepSeek's Continue/Retry buttons intermittently ignore.
  if (request.action === 'trustedClick' && sender.tab && typeof sender.tab.id === 'number') {
    TrustedInput.click(sender.tab.id, request.x, request.y)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const session of Orchestrator.sessions.values()) {
    if (session.plannerTabId === tabId) {
      console.warn(`[background] planner tab for task ${session.taskId} closed unexpectedly.`);
      session.plannerTabId = null;
    }
    if (session.executorTabId === tabId) {
      console.warn(`[background] executor tab for task ${session.taskId} closed unexpectedly.`);
      session.executorTabId = null;
    }
  }
});
