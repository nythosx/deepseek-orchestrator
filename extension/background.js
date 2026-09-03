// MV3 service worker. Classic script (not a module) so importScripts shares one global scope.
importScripts(
  'lib/protocol.js',
  'lib/nativeBridge.js',
  'lib/tabs.js',
  'lib/toolCalls.js',
  'lib/orchestrator.js'
);

function handleCliPayload(payload) {
  if (!payload || !payload.type) return;

  if (payload.type === CLI_MESSAGE_TYPES.RUN_TASK) {
    Orchestrator.runTask(
      payload.taskId,
      payload.task,
      payload.options || {},
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
    Orchestrator.answerQuestion(payload.questionId, payload.answer);
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
  console.warn('[background] native host connection lost; will reconnect on next tool call.');
});

// connect() is idempotent (no-op if a port is already open), so it's safe to call
// from every event that might be this service worker's first wake-up.
chrome.runtime.onStartup.addListener(() => NativeBridge.connect());
chrome.runtime.onInstalled.addListener(() => NativeBridge.connect());
NativeBridge.connect();

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

// See TabManager.refocusTab's comment (extension/lib/tabs.js) — content.js's poll loop
// can't call chrome.windows itself (content scripts don't get that API), so it asks the
// background page to do it periodically for the whole duration of a long wait, not just
// once at send time.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'refocusTab' && sender.tab && typeof sender.tab.id === 'number') {
    TabManager.refocusTab(sender.tab.id).then(() => sendResponse({ ok: true }));
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
