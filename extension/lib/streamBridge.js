// MAIN-world script (see manifest.json's second content_scripts entry). Runs in the page's
// own JS realm, unlike content.js (isolated world) — that's required to patch the SAME
// `window.fetch` DeepSeek's own app code calls. An isolated-world script can only patch its
// own private copy of fetch, which the page never sees or uses.
//
// Purpose: DOM-based "is DeepSeek done generating" detection (content.js's
// waitForAssistantSettle) has to dead-reckon completion — wait STABLE_MS (1.2s) for text to
// stop changing, then up to BUTTON_READY_GRACE_MS (8s) for the send button to confirm — because
// it has no ground-truth signal, only inference from rendered markup. The response stream
// itself closing IS ground truth and is available the instant it happens, with none of that
// stacked latency. This script watches for it and hands the moment off to content.js.
//
// Safety: only OBSERVES via response.clone() — the original Response returned to the page's
// own code is completely untouched (same body, same timing, same everything). No outgoing
// request is added, delayed, or modified, and no header/timing signature visible to
// DeepSeek's server changes at all. This is the same passive-observer pattern used by
// countless benign extensions (translators, readers, dev tools) and carries no anti-bot risk
// beyond what page-script injection itself already has.
(function () {
  if (window.__mccStreamBridgeInstalled) return; // survives re-injection on SPA navigation
  window.__mccStreamBridgeInstalled = true;

  function emit(type, detail) {
    try {
      document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(detail) }));
    } catch (_) {
      // Never let a bridging failure surface to the page.
    }
  }

  // Confirmed live (2026-08-14) against the real site: chat.deepseek.com's actual completion
  // endpoint is POST https://chat.deepseek.com/api/v0/chat/completion (captured via DevTools
  // network inspection of a real turn). Matching on this directly, rather than only guessing
  // from response content-type, is what makes this reliable — content-type alone turned out
  // to under-match (see the fallback below for why it's kept as a second tier anyway).
  const CHAT_COMPLETION_URL_RE = /\/api\/v\d+\/chat\/completion(?:[/?#]|$)/;

  function looksLikeStream(response, url) {
    if (!response || !response.body) return false;
    if (typeof url === 'string' && CHAT_COMPLETION_URL_RE.test(url)) return true;
    // Fallback for a future endpoint-path change, or any other streamed response worth
    // tracking — content.js never trusts this signal alone (see waitForAssistantSettle's
    // use), so an over-broad match here just means one wasted read of an unrelated stream,
    // never a wrong "done" resolution.
    const ct = response.headers.get('content-type') || '';
    return ct.includes('text/event-stream') || ct.includes('application/x-ndjson') || ct.includes('stream');
  }

  function urlOf(args) {
    try {
      const req = args[0];
      return typeof req === 'string' ? req : req && req.url;
    } catch (_) {
      return '';
    }
  }

  function watch(response, url) {
    try {
      if (!looksLikeStream(response, url)) return;
      emit('mcc:stream-start', { url, ts: Date.now() });
      // Read a CLONE, not the response the page itself will consume — the page's own reader
      // is completely independent of this one, so nothing about its stream is delayed,
      // buffered, or altered by us reading alongside it.
      const reader = response.clone().body.getReader();
      (async () => {
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch (_) {
          // A read error here (e.g. the page aborted the real stream) isn't our concern —
          // just stop watching quietly, don't emit a false "done".
          return;
        }
        emit('mcc:stream-done', { url, ts: Date.now() });
      })();
    } catch (_) {
      // Any failure in the watcher must never affect the response handed back to the page.
    }
  }

  // Wraps whatever function is CURRENTLY window.fetch at call time (via the accessor property
  // below), not a one-time-captured reference. Observed live (2026-08-14): DeepSeek's own
  // app code reassigns `window.fetch` to its own instrumentation wrapper sometime after this
  // document_start script runs — a plain `const originalFetch = window.fetch; window.fetch =
  // function(...) { ...originalFetch... }` approach gets silently discarded when that
  // reassignment happens, since it replaces window.fetch outright rather than layering on top
  // of ours. Confirmed via a real turn: window.fetch.toString() showed a short, unrelated
  // minified function with none of this wrapper's markers, and zero mcc:stream-* events ever
  // fired despite a real completion request going out. The accessor property below intercepts
  // ANY future `window.fetch = ...` assignment (from either side) and re-wraps it, so
  // detection survives no matter what order the two patches happen in.
  function wrap(fn) {
    if (typeof fn !== 'function' || fn.__mccWrapped) return fn;
    const wrapped = function (...args) {
      const url = urlOf(args);
      const result = fn.apply(this, args);
      if (result && typeof result.then === 'function') {
        return result.then((response) => {
          watch(response, url);
          return response;
        });
      }
      return result;
    };
    wrapped.__mccWrapped = true;
    return wrapped;
  }

  let current = wrap(window.fetch.bind(window));
  try {
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      enumerable: true,
      get() {
        return current;
      },
      set(next) {
        current = wrap(next);
      },
    });
  } catch (_) {
    // If the environment won't allow redefining window.fetch for some reason, fall back to a
    // plain one-time patch — better than throwing and breaking page load entirely.
    window.fetch = current;
  }
})();
