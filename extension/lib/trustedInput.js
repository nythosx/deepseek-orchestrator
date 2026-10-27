// Trusted (isTrusted: true) mouse clicks via the Chrome DevTools Protocol.
//
// Every DOM-side activation content.js can do — dispatchEvent with Mouse/PointerEvent,
// HTMLElement.click(), calling React's __reactProps$ onClick directly — produces events
// with isTrusted === false, and DeepSeek's Continue button ignores those intermittently.
// Input.dispatchMouseEvent goes through the browser's real input pipeline (hit-testing,
// hover, focus, pointer capture), indistinguishable from a physical click.
//
// Cost: while attached, Chrome shows a "MyClaudeCode Agent started debugging this browser"
// infobar, and DevTools' own debugger can't attach to the same tab. To keep the infobar
// from flickering on every click during a response that needs many Continue cycles, the
// debugger stays attached and is detached after IDLE_DETACH_MS without another click.
const TrustedInput = (() => {
  const PROTOCOL_VERSION = '1.3';
  const IDLE_DETACH_MS = 30000;
  const attached = new Map(); // tabId -> detach timer id

  chrome.debugger.onDetach.addListener((source) => {
    // User dismissed the infobar ("Cancel"), the tab closed, or DevTools took over.
    if (typeof source.tabId !== 'number') return;
    const timer = attached.get(source.tabId);
    if (timer) clearTimeout(timer);
    attached.delete(source.tabId);
  });

  function scheduleDetach(tabId) {
    const prev = attached.get(tabId);
    if (prev) clearTimeout(prev);
    attached.set(
      tabId,
      setTimeout(() => {
        attached.delete(tabId);
        chrome.debugger.detach({ tabId }).catch(() => {});
      }, IDLE_DETACH_MS)
    );
  }

  async function ensureAttached(tabId) {
    if (attached.has(tabId)) return;
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    } catch (err) {
      // The service worker may have restarted and lost the map while Chrome still has
      // our debugger attached — that's fine, reuse it. Anything else (DevTools open on
      // this tab, chrome:// page) is a real failure.
      if (!/already attached/i.test(String(err && err.message))) throw err;
    }
    attached.set(tabId, null);
  }

  function mouse(tabId, type, x, y, extra) {
    return chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      pointerType: 'mouse',
      ...extra,
    });
  }

  // x, y: CSS pixels relative to the top frame's viewport (getBoundingClientRect space).
  async function click(tabId, x, y) {
    await ensureAttached(tabId);
    try {
      await mouse(tabId, 'mouseMoved', x, y, { buttons: 0 });
      await mouse(tabId, 'mousePressed', x, y, { buttons: 1, clickCount: 1 });
      await mouse(tabId, 'mouseReleased', x, y, { buttons: 0, clickCount: 1 });
    } finally {
      scheduleDetach(tabId);
    }
  }

  return { click };
})();
