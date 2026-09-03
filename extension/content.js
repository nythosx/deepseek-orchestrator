// Injected into the chat page (mock backend today, chat.deepseek.com later — step 10).
// Exposes typeAndSend / extractLastResponse / editMessage / toggleWebSearch / waitForReady
// to the background service worker via chrome.runtime.onMessage.

(function () {
  // Cheap injection canary — logs once, immediately, so a "Tab did not become ready" error
  // upstream (tabs.js's waitForReady) can be told apart at a glance: if this line is missing
  // from the tab's console entirely, the content script never ran at all (extension not
  // reloaded, manifest match/permission issue, or a load-time exception below this point) —
  // a completely different failure than the script running but its onMessage listener not
  // answering in time.
  console.log('[MyClaudeCode] content script loaded on', document.location.pathname);

  // Bridged from streamBridge.js (a separate MAIN-world content script, see manifest.json)
  // via CustomEvents dispatched on `document` — the isolated/MAIN world split means we can't
  // share variables directly, but both sides see the same DOM and its events. Tracks the most
  // recent streamed-response start/close timestamps so waitForAssistantSettle can treat the
  // network stream actually closing as a fast, ground-truth completion signal instead of
  // purely dead-reckoning from STABLE_MS/BUTTON_READY_GRACE_MS. This is only ever a hint that
  // shortens those two waits, never a standalone resolve condition — the existing DOM checks
  // (non-empty bubble, not thinking, no Stopped badge, text unchanged) still gate every
  // resolve() below, so a mismatched signal (e.g. an unrelated streamed request on the page)
  // can only fail to speed things up, never cause a wrong early resolution.
  let lastStreamDoneAt = 0;
  document.addEventListener('mcc:stream-done', (e) => {
    try { lastStreamDoneAt = JSON.parse(e.detail).ts; } catch (_) { /* ignore malformed bridge event */ }
  });

  const RESPONSE_TIMEOUT_MS = 60000;
  // Once an assistant message's text stops changing for this long, treat it as finished.
  // Needed for chat.deepseek.com, whose streaming-state markup is transient and undocumented
  // here — unlike the mock backend, which flags it with a plain ".generating" class we can
  // check directly (see readme.md section 10 on selector fallbacks + UI-change resilience).
  const STABLE_MS = 1200;
  // Used instead of STABLE_MS/BUTTON_READY_GRACE_MS when streamBridge.js's mcc:stream-done
  // signal confirms this turn's network stream already closed at/after the bubble's last text
  // change — see the "streamConfirmedDone" branch in waitForAssistantSettle. Not zero: a tiny
  // debounce is still needed for React to finish its own paint after the stream closes, and a
  // moment for the send button's disabled class to catch up — just far short of the blind
  // 1200ms/8000ms dead-reckoning waits, which assumed no better signal was available.
  const STREAM_CONFIRMED_STABLE_MS = 150;
  const STREAM_CONFIRMED_BUTTON_GRACE_MS = 500;

  // Multiple fallback selectors per element so both the mock backend and the real site
  // (chat.deepseek.com, reverse-engineered from saved pages — see deepseek.html in the
  // repo root) work without touching the calling code (readme.md section 10).
  const SELECTORS = {
    textarea: [
      '#chat-input',
      '[data-testid="chat-input"]',
      'textarea[placeholder="Message DeepSeek"]',
      'textarea[placeholder*="Message"]',
    ],
    sendButton: [
      '#send-btn',
      '[data-testid="send-button"]',
      'div[role="button"].ds-button--primary.ds-button--circle',
    ],
    webSearchToggle: ['#web-search-toggle', '[data-testid="web-search-toggle"]'],
    messageList: ['#messages', '[data-testid="message-list"]'],
    // The mock backend wraps assistant text in a bubble with a nested ".msg-text" node;
    // DeepSeek's ".ds-assistant-message-main-content" *is* the text container itself.
    assistantMessage: '.msg-assistant, .ds-assistant-message-main-content',
    editButton: '.msg-edit-btn',
    // The real site's edit-mode textarea, captured from its actual outerHTML.
    editTextarea: ['textarea[name="user query"]'],
  };

  // DeepSeek has no aria-label or data-testid on its icon-only hover-toolbar buttons (edit,
  // copy, etc.) — they're all the same generic ds-button component with different SVG icon
  // content. The path data is the only stable-ish fingerprint available; captured directly
  // from the pencil/edit icon's outerHTML. Brittle across a visual redesign, but that's true
  // of any selector here (see readme.md section 10 on UI-change resilience).
  const EDIT_ICON_PATH_PREFIX = 'M9.94076 1.34942C10.7047';
  // The edit-mode confirm button, unlike the icon buttons, does have visible text ("Send",
  // not "Save" — captured from its real outerHTML too).
  const EDIT_SEND_BUTTON_TEXT = 'send';
  // The small circular-arrow retry button that sits next to a "Stopped" badge (see
  // hasStoppedGenerationBadge) — a DIFFERENT button than findRetryButton's `ds-button--
  // warning` one below (that's for generation failing outright with no response at all; this
  // is specifically the one next to a message that streamed content and then got cut off).
  // No warning styling, no text label, and its classes are otherwise the same generic hashed
  // ds-button component as every other icon button — the SVG path is the only stable
  // fingerprint, same reasoning as EDIT_ICON_PATH_PREFIX above. Captured from real
  // chat.deepseek.com outerHTML pasted live (2026-08-15).
  const STOPPED_RETRY_ICON_PATH_PREFIX = 'M7.92136 0.349152C10.3744';
  // Shares diagnostics.continueOrRetryClicks with the Continue/Retry-button handling at the
  // top of the poll loop (same "how many times has this turn had to click something to keep
  // going" counter) — capped so a Stopped state that keeps recurring even after clicking
  // (DeepSeek itself having a bad time, not just this one response) still falls through to a
  // real reject/retry instead of clicking forever.
  const STOPPED_RETRY_MAX_CLICKS = 3;

  function query(selectors) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function findButtonByIconPath(root, pathPrefix) {
    const paths = root.querySelectorAll('svg path');
    for (const p of paths) {
      const d = p.getAttribute('d') || '';
      if (d.startsWith(pathPrefix)) return p.closest('[role="button"]');
    }
    return null;
  }

  function findButtonByText(root, text) {
    const buttons = root.querySelectorAll('[role="button"], button');
    for (const b of buttons) {
      if ((b.textContent || '').trim().toLowerCase() === text.toLowerCase()) return b;
    }
    return null;
  }

  // ".ds-message" matches both user and assistant bubbles on the real site — there's no
  // user-specific class, so user messages are identified by NOT containing the
  // assistant-content marker. The mock backend's ".msg-user" is already role-specific.
  function getUserMessageEls() {
    const mockEls = document.querySelectorAll('.msg-user');
    if (mockEls.length) return Array.from(mockEls);
    return Array.from(document.querySelectorAll('.ds-message')).filter(
      (el) => !el.querySelector('.ds-assistant-message-main-content')
    );
  }

  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'UL', 'OL', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TR',
  ]);

  // Manually walks the DOM to build a plain-text version of a message, reconstructing
  // ```-fenced code blocks along the way. Two things push this past a plain .innerText:
  //  1. DeepSeek's rendered code blocks have no literal ``` markers at all (those are
  //     markdown *source* syntax, consumed by rendering) — .innerText on the whole
  //     message also picks up the code block's "Copy"/"Download" button label text,
  //     since that lives in a sibling banner div right next to the <pre>.
  //  2. .innerText requires the element to have live layout; a detached clone (the
  //     obvious way to strip the banner before reading .innerText) returns "" in Chrome.
  // So: walk the live DOM, special-case `.md-code-block` to emit a fenced block built
  // from just its `<pre>` content (skipping the banner), and insert '\n' after other
  // block-level elements the way rendered layout would.
  function serializeNode(node, out) {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.textContent);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    // Observed live (2026-08-10): a model's real multi-line reply — several separate
    // "!SHELL <command>" lines — arrived at the orchestrator glued into one line with NO
    // separator at all (e.g. "git add .!SHELL git commit..."), which the corruption
    // detector then had to catch and nudge around. Root cause: markdown renderers commonly
    // emit a single-newline line break *within* a paragraph as `<br>`, reserving a real new
    // `<p>` for a blank-line-separated paragraph break. `<br>` was missing from BLOCK_TAGS,
    // so serializeNode silently dropped every such line break instead of emitting '\n' for
    // it — this wasn't the model's formatting mistake, it was ours.
    if (node.tagName === 'BR') {
      out.push('\n');
      return;
    }

    if (node.classList && node.classList.contains('md-code-block')) {
      const pre = node.querySelector('pre');
      const code = (pre ? pre.textContent : '') || '';
      out.push(`\n\`\`\`\n${code.replace(/\n+$/, '')}\n\`\`\`\n`);
      return; // don't descend — skips the banner's language label / Copy / Download text
    }

    for (const child of node.childNodes) serializeNode(child, out);
    if (BLOCK_TAGS.has(node.tagName)) out.push('\n');
  }

  function messageText(el) {
    const inner = el.querySelector('.msg-text');
    if (inner) return inner.innerText || inner.textContent || '';

    const out = [];
    serializeNode(el, out);
    return out
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function setNativeValue(element, value) {
    const proto = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  // How long we're willing to let simulated typing run before giving up and pasting the
  // rest instantly. A real paste is one native `input` event with the full value already
  // set — indistinguishable at the DOM level from an actual Ctrl+V, and pasting long text
  // (a system prompt, a code block) is completely ordinary human behavior. It reads as
  // less anomalous than a single message taking 60+ seconds of uniform robotic typing
  // under Chrome's background-tab throttling.
  const TYPE_TIME_BUDGET_MS = 10000;
  const AVG_CHUNK_CHARS = 3.5; // midpoint of the 2-5 char burst range below

  function pasteValue(el, text) {
    el.focus();
    setNativeValue(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Types in small random-sized bursts (2-5 chars) rather than one setTimeout per
  // character. A long primer is otherwise hundreds of individual timers, and Chrome
  // throttles setTimeout heavily in windows that lose OS focus — turning ~40s of typing
  // into minutes with no error, just silence. Bursts cut that timer count by ~70-80%
  // while staying just as human-plausible (people type in bursts, not metronomically).
  //
  // If typing this out is estimated to exceed TYPE_TIME_BUDGET_MS (or `instant` is set —
  // used for the long planner/executor primer messages, which no human types live), paste
  // the whole thing instantly instead of simulating keystrokes at all.
  async function typeIntoElement(el, text, { delayRange = [50, 150], instant = false } = {}) {
    const avgDelayMs = (delayRange[0] + delayRange[1]) / 2;
    const estimatedMs = (text.length / AVG_CHUNK_CHARS) * avgDelayMs;

    if (instant || estimatedMs > TYPE_TIME_BUDGET_MS) {
      pasteValue(el, text);
      return;
    }

    el.focus();
    setNativeValue(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    let i = 0;
    while (i < text.length) {
      const chunkSize = Math.min(text.length - i, 2 + Math.floor(Math.random() * 4)); // 2-5 chars
      setNativeValue(el, el.value + text.slice(i, i + chunkSize));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      i += chunkSize;
      await sleep(randomBetween(delayRange[0], delayRange[1]));
    }
  }

  function waitForReadyState(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        const textarea = query(SELECTORS.textarea);
        if (textarea && !textarea.disabled) return resolve(true);
        if (Date.now() - start > timeoutMs) return reject(new Error('Chat input never became ready.'));
        setTimeout(poll, 200);
      })();
    });
  }

  // DeepSeek cuts generation short on very long responses and shows a "Continue" button
  // instead of finishing. Without handling this, the response text simply stops changing
  // (generation paused, not done) and our stabilization detection below wrongly treats
  // that as "finished" — sending our next message while DeepSeek still has an incomplete,
  // paused response sitting there, which desyncs the conversation from what we think
  // happened. Confirmed against real chat.deepseek.com outerHTML.
  function findContinueButton() {
    return findButtonByText(document, 'continue');
  }

  // The OTHER stuck-response shape: when generation fails outright (no response at all —
  // distinct from the "cut off mid-way" Continue case above), DeepSeek shows a small
  // circular warning-styled icon button with no text label, just a retry-arrow SVG.
  // Confirmed against real chat.deepseek.com outerHTML: `role="button"` with
  // `ds-button--warning` in its class list — that particular class looks like a stable,
  // semantic design-system name (unlike the random hashed classes alongside it), not
  // something likely to be a one-off styling accident. Reused as-is (not a separate
  // selector) for the "Check network and retry." banner's own retry button too — confirmed
  // live (2026-08-15) it carries the exact same `ds-button--warning` class, i.e. it's
  // DeepSeek's one generic "something failed, click to retry" component shown in both
  // places, not two different buttons that happen to look similar.
  function findRetryButton() {
    return document.querySelector('[role="button"].ds-button--warning');
  }

  // The "Stopped" badge's own adjacent retry button (see STOPPED_RETRY_ICON_PATH_PREFIX) —
  // clicking DeepSeek's own retry, right where it happened, instead of failing the whole
  // turn and having the orchestrator resend the prompt as a brand-new message from scratch.
  function findStoppedRetryButton() {
    return findButtonByIconPath(document, STOPPED_RETRY_ICON_PATH_PREFIX);
  }

  // The broadest container a turn's response — bubble or not — is ever inside: `.ds-message`
  // wraps BOTH user and assistant turns (see getUserMessageEls's comment), and a new one is
  // always appended for a fresh turn even before that turn has any real content yet. Used to
  // scope the Stopped-badge check above narrowly enough to avoid a stale earlier-turn false
  // positive, without requiring SELECTORS.assistantMessage's narrower element (which a
  // stopped-with-no-answer turn may never actually get) to exist first.
  function lastMessageContainer() {
    const all = document.querySelectorAll('.ds-message');
    return all.length ? all[all.length - 1] : null;
  }

  // A bare `.click()` doesn't always reach a framework's real event handlers if it's
  // listening for pointer/mouse events specifically rather than the synthetic click DOM
  // fires. Dispatch a full, realistic event sequence as well, belt-and-suspenders.
  function robustClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      try {
        el.dispatchEvent(new MouseEvent(type, opts));
      } catch (_) {
        // PointerEvent may not exist in some contexts; MouseEvent is the safe fallback.
      }
    }
    el.click();
  }

  // DeepSeek shows this exact text inline in the chat when its own connection drops
  // mid-response. Observed live: without detecting this explicitly, the system just kept
  // treating the resulting stalled/garbled state as a normal (if slow) response and let the
  // model narrate around the failure instead of surfacing the real problem.
  //
  // Observed live (2026-08-13/14), same failure class as hasCaptchaChallenge's original bug:
  // this task's own subtask involved diffing content.js, which contains this exact string as
  // its own detection literal — an unscoped body-text scan matched that quoted diff text and
  // falsely reported a network error mid-response with nothing actually wrong. Unlike the
  // CAPTCHA case, there's no interactive-widget signal to fall back on here, so instead this
  // skips text inside <pre>/<code> — diffs, command output, and quoted code always render
  // there, while a real inline banner from DeepSeek's own UI never does.
  function hasNetworkErrorBanner() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement && node.parentElement.closest('pre, code')) continue;
      if ((node.textContent || '').includes('Check network and retry.')) return true;
    }
    return false;
  }

  // DeepSeek shows this exact banner when a chat has grown past its own context/length
  // limit — "Length limit reached. Please start a new chat." Unlike a network hiccup or a
  // transient CAPTCHA flash, waiting this one out never helps: the chat is genuinely full
  // and no further message will ever send in it. This is specific, unusual UI copy that
  // wouldn't plausibly appear quoted inside ordinary code/diff content, but scoped away from
  // <pre>/<code> anyway for the same reason as hasNetworkErrorBanner above.
  //
  // Observed live (2026-08-14): same false-positive class as the original CAPTCHA bug — this
  // fired for a response DeepSeek actually answered normally (the user watched it happen in
  // the tab). Root cause is almost certainly the same fix that CAPTCHA needed: the banner can
  // stay sitting in the DOM (from an earlier turn, or a dismissed/hidden overlay) without
  // being the actual current, on-screen state. Requiring the containing element to actually
  // be visible — same isVisibleElement check as the CAPTCHA iframe — rules that out.
  function hasLengthLimitReached() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement && node.parentElement.closest('pre, code')) continue;
      if (!(node.textContent || '').includes('Length limit reached')) continue;
      if (node.parentElement && isVisibleElement(node.parentElement)) return true;
    }
    return false;
  }

  // DeepThink (reasoning mode) sometimes halts generation mid-thinking and never produces
  // a real answer — the thinking panel's header shows a small "Stopped" badge instead of
  // the usual "Thought for Ns" label once that happens. Without detecting this explicitly,
  // the bug this fixes: the (now-frozen) thinking text just stops changing, and the
  // stabilization tier below (STABLE_MS) can't tell that apart from a genuinely finished
  // response — it accepts the frozen reasoning text as the final answer.
  // Best-effort, unconfirmed against real chat.deepseek.com outerHTML (no captured DOM
  // available for this specific state — see readme.md section 11 on the general risk of
  // selectors here). Scoped to short, badge-like leaf elements (no children) with EXACTLY
  // this text, not arbitrary prose that happens to contain the word "stopped", to keep
  // false positives unlikely. Scoped to `scopeEl` (the current assistant bubble) rather than
  // the whole document, so a Stopped badge left over from an earlier, unrelated turn can't
  // false-positive a later one.
  function hasStoppedGenerationBadge(scopeEl) {
    if (!scopeEl) return false;
    const candidates = scopeEl.querySelectorAll('span, div, button, [role="status"]');
    for (const el of candidates) {
      if (el.children.length > 0) continue; // leaf nodes only — a real badge has no nested markup
      if ((el.textContent || '').trim() === 'Stopped') return true;
    }
    return false;
  }

  // DeepThink can go quiet BETWEEN reasoning steps for well over STABLE_MS/RESPONSE_TIMEOUT_MS
  // while still genuinely thinking — no "Stopped" badge, no real answer yet, just a pause in
  // an otherwise-still-in-progress chain of thought. Without detecting this, the same
  // stabilization tier that's supposed to mean "finished" (text unchanged for STABLE_MS) or
  // the inactivity timeout (unchanged for RESPONSE_TIMEOUT_MS) can both fire mid-thought —
  // resolving with an incomplete reasoning fragment as if it were the real answer, or failing
  // the turn outright as "stalled" when it's actually just still working.
  // Best-effort, unconfirmed against real chat.deepseek.com outerHTML (same caveat as
  // hasStoppedGenerationBadge — no captured DOM for this specific state). Heuristic: the
  // header DeepThink shows WHILE reasoning is in progress reads "Thinking" (sometimes with a
  // trailing ellipsis or elapsed seconds); once finished it switches to a static "Thought for
  // Ns" label instead — so matching a short leaf element that STARTS WITH "Thinking" (rather
  // than requiring an exact match, since a live elapsed-time suffix is plausible) is the
  // signal used here. Scoped to `scopeEl` for the same reason as the Stopped-badge check.
  function hasActiveThinkingIndicator(scopeEl) {
    if (!scopeEl) return false;
    const candidates = scopeEl.querySelectorAll('span, div, [role="status"]');
    for (const el of candidates) {
      if (el.children.length > 0) continue; // leaf nodes only
      const text = (el.textContent || '').trim();
      if (/^Thinking(\.\.\.|…)?$/i.test(text)) return true;
    }
    return false;
  }

  // No captured DOM for DeepSeek's CAPTCHA challenge either — this tool has no way to
  // solve one, so the goal here is purely fast, honest detection instead of silently
  // stalling all the way to a timeout (readme.md section 13's "no CAPTCHA handling" gap).
  // Checks the common iframe-based providers (recaptcha/hcaptcha/turnstile) by src, plus a
  // couple of generic human-verification phrases, so this isn't tied to one specific vendor.
  //
  // Observed live (2026-08-13): the plain src-match version below false-positived and
  // aborted a real task with no CAPTCHA anywhere on screen — almost certainly an invisible
  // Cloudflare Turnstile widget, which sites commonly embed on every page load as a
  // background bot-protection token that never shows the user anything. `turnstile` in an
  // iframe's src is normal, silent background infrastructure, not evidence of a challenge
  // actually being presented. Fixed by requiring the iframe to actually be VISIBLE (real
  // on-screen size, not display:none/visibility:hidden/0-by-0) before it counts — a genuine
  // blocking challenge is shown to the user; an invisible token never is.
  const CAPTCHA_IFRAME_RE = /recaptcha|hcaptcha|turnstile|captcha/i;

  function isVisibleElement(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return false; // invisible tokens are typically 0x0 or 1x1
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  }

  // Observed live (2026-08-13): a body-wide text scan for phrases like "verify you are human"
  // (the previous approach here) kept false-positiving on a coding agent's own normal traffic —
  // a git diff of THIS file, echoed back inside an assistant reply, contains those exact words
  // as data, not as a real challenge. Tried excluding the message-list container's text, but
  // that's still fragile against streaming/DOM-timing edge cases (confirmed live: still
  // false-positived once even with the exclusion in place). A real CAPTCHA challenge is
  // presented as an interactive widget — an iframe — not as scannable body text, so this
  // relies solely on the iframe check, which doesn't share this failure mode at all.
  function hasCaptchaChallenge() {
    for (const frame of document.querySelectorAll('iframe')) {
      const src = frame.getAttribute('src') || '';
      if (CAPTCHA_IFRAME_RE.test(src) && isVisibleElement(frame)) return true;
    }
    return false;
  }

  // The send button carries `ds-button--disabled` (or aria-disabled="true") both while the
  // textarea is empty AND, observed live, while DeepSeek is still finishing up a response —
  // it briefly re-disables/re-enables around generation boundaries independent of the
  // textarea's own content. That makes it a second, independent "is DeepSeek actually done"
  // signal, distinct from the text-stabilization heuristic below (STABLE_MS) — text can go
  // quiet for 1.2s mid-response (e.g. between paragraphs, or during a brief server-side
  // pause) while the button is still disabled, which text-stabilization alone can't tell
  // apart from a genuinely finished response. Requiring both before declaring "done" is what
  // this addresses; see its use in waitForAssistantSettle's stabilization branch and in
  // typeAndSend's pre-send check (the user reported an observed >1min gap between DeepSeek
  // finishing and our next send actually registering — consistent with sending into a
  // button that looked present but was still mid-transition).
  function isSendButtonDisabled(btn) {
    const el = btn || query(SELECTORS.sendButton);
    if (!el) return true; // no button found — can't confirm ready, treat as not-ready
    if (el.classList && el.classList.contains('ds-button--disabled')) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    return false;
  }

  // Called right before typing a brand new message. If a previous turn left a Continue or
  // Retry button sitting unresolved (e.g. it appeared after our own wait already gave up,
  // or some other desync), clicking through it here — before we submit anything new —
  // stops us from talking past a response DeepSeek considers still incomplete. Bounded
  // retry loop, not indefinite: if these don't clear on their own, surface that instead of
  // silently hanging forever.
  async function clearStuckButtons({ attempts = 5, delayMs = 1000 } = {}) {
    for (let i = 0; i < attempts; i++) {
      const continueBtn = findContinueButton();
      const retryBtn = findRetryButton();
      if (!continueBtn && !retryBtn) return;
      console.log(`[MyClaudeCode] Clearing stuck ${continueBtn ? 'Continue' : 'Retry'} button before sending.`);
      robustClick(continueBtn || retryBtn);
      await sleep(delayMs);
    }
  }

  // Absolute ceiling — only fires if something is truly, permanently stuck (e.g. the tab
  // navigated away). Not the normal timeout path; see INACTIVITY_TIMEOUT_MS below.
  const ABSOLUTE_TIMEOUT_MS = 10 * 60 * 1000;
  // A long system-priming message is now instant-pasted (not typed out over 30-60s the
  // way it used to be), so DeepSeek can genuinely take a while just to start visibly
  // responding to it — no bubble, no streaming text, nothing yet. That "still processing,
  // nothing rendered" phase needs a much longer grace period than a stall *after* the
  // response has already started (which is a much stronger signal something is actually
  // wrong). Observed live: the default 60s inactivity window was firing on real, if slow,
  // primer responses that simply hadn't started rendering yet.
  const INITIAL_RESPONSE_GRACE_MS = 3 * 60 * 1000;

  // Waits for a genuinely NEW assistant bubble (one that didn't exist at `baselineCount`,
  // the number of assistant messages present right before the caller clicked send/save) to
  // appear and finish generating.
  //
  // Observed live (2026-08-10): the previous version trusted "whatever's currently last in
  // the DOM" from the very first poll tick, on the assumption that a send synchronously
  // appends a fresh assistant element. On the real site it doesn't — there's real
  // network/render latency before the new bubble even exists. If that gap exceeds STABLE_MS
  // (1.2s), the old code would see the *previous* turn's already-settled bubble, judge its
  // unchanged text "stable", and resolve with stale, wrong content — concretely, the
  // executor's response to the very first subtask kept coming back as a generic "I'm ready,
  // what would you like me to build?" on every real test, which turned out to be the
  // *primer's own* reply being mistaken for the subtask's reply. Now: text-stabilization
  // logic never even runs until assistantMsgs.length > baselineCount confirms a new bubble
  // actually exists; until then this just waits, same as if nothing had rendered yet.
  //
  // Detection has two tiers, chosen per poll tick based on what markup is present:
  //  1. Class-based (mock backend): the bubble gets a ".done" class the instant its
  //     final text is set, so we can trust and resolve on it immediately.
  //  2. Stabilization (real site, or any UI without a known done/generating class):
  //     treat the text as final once it hasn't changed for STABLE_MS. Slower (adds a
  //     fixed tail latency) but doesn't depend on guessing the site's streaming markup.
  //
  // Timeout is INACTIVITY-based, not a fixed wall-clock deadline — a genuinely long
  // response that's still actively growing (or one that needed a Continue click) must
  // not get killed just for taking a while. Only truly stalled progress times out.
  function waitForAssistantSettle(baselineCount, inactivityTimeoutMs = RESPONSE_TIMEOUT_MS, baselineLastNode = null) {
    return new Promise((resolve, reject) => {
      const absoluteDeadline = Date.now() + ABSOLUTE_TIMEOUT_MS;
      let lastText = null;
      let lastChangeAt = Date.now();
      let lastProgressAt = Date.now(); // any sign of life: text growing, Continue clicked
      let sawAnyText = false; // false until the response has visibly started at all
      let networkErrorSince = null;
      // Mirrors the "connecting..." reconnect pattern: don't kill the task on the first
      // sighting of a network error, since the connection can legitimately come back within
      // a few seconds. Give it a handful of short retries before actually giving up — bumped
      // from 10 to 20 (30s to 60s total) per live feedback (2026-08-15): now that each tick
      // also actively clicks DeepSeek's own retry button instead of just waiting, a longer
      // window means more chances for that click to actually take effect on a slower
      // reconnect, not just more passive waiting.
      const NETWORK_ERROR_RETRY_ATTEMPTS = 20;
      const NETWORK_ERROR_RETRY_INTERVAL_MS = 3000;
      const NETWORK_ERROR_GRACE_MS = NETWORK_ERROR_RETRY_ATTEMPTS * NETWORK_ERROR_RETRY_INTERVAL_MS;
      let captchaSince = null;
      // Bounds how long the button-ready check (below) can hold up an otherwise-stable
      // response — protects against a future selector change making SELECTORS.sendButton
      // never match (isSendButtonDisabled's null-button fallback is "not ready"), which
      // would otherwise stall every single turn out to the full absolute ceiling instead of
      // just trusting text-stabilization alone the way this used to work.
      let buttonWaitSince = null;
      const BUTTON_READY_GRACE_MS = 8000;
      const pollStartedAt = Date.now();
      // See TabManager.refocusTab's comment (extension/lib/tabs.js) — tabs.js's sendToTab
      // only forces real OS-level focus ONCE, at the moment a message is sent. That's not
      // enough for a wait that can run minutes: focus drifting back to whatever the human is
      // doing elsewhere lets Chrome re-throttle this tab's own timers partway through,
      // silently stretching every interval below (STABLE_MS, the 250ms poll cadence, all of
      // it) well past their coded values. Confirmed live (2026-08-14): pollTickCount as low
      // as 9 across a ~237s wait, with zero bubbles ever rendering, once focus had drifted
      // away again after the initial send.
      //
      // REACTIVE, not blind/periodic (changed 2026-08-15 per live feedback — the original
      // unconditional-every-10s version yanked OS window focus away from whatever the user
      // was doing at the time regardless of whether the tab actually needed it, which is
      // exactly the "why does my browser keep stealing focus" annoyance that was reported).
      // Every REFOCUS_CHECK_INTERVAL_MS this measures the ACTUAL observed ms/tick over the
      // window just elapsed and only asks background.js to refocus (chrome.windows.update)
      // if that rate shows real throttling — a tab that's ticking at its normal ~250ms
      // cadence (nothing stole its focus, or Chrome just isn't throttling it) is left alone
      // entirely, never touching the user's actual window focus. Fire-and-forget either way:
      // a content script can't call chrome.windows itself, so this asks background.js to do
      // it (see its 'refocusTab' handler); failure here only ever means slower detection,
      // never a wrong result, so it's never awaited or allowed to affect the poll loop's own
      // timing.
      const REFOCUS_CHECK_INTERVAL_MS = 5000;
      // A little above the nominal 250ms poll cadence, to absorb normal jitter (GC pauses,
      // a burst of DOM mutations) without treating it as throttling — this is meant to catch
      // the ~10-16x slowdown Chrome's actual background-tab throttling produces, not shave
      // milliseconds off a perfectly healthy tab.
      const HEALTHY_MS_PER_TICK = 600;
      let lastRefocusCheckAt = pollStartedAt;
      let ticksAtLastRefocusCheck = 0;
      // Surfaced to orchestrator.js as part of the TIMING message (see
      // CLI_MESSAGE_TYPES.TIMING) so a slow turn's cause is visible, not just its duration —
      // `state` is the last observed activity right before this resolved/rejected (what
      // DeepSeek was actually doing), `timeToFirstTextMs` isolates the "hasn't started
      // responding at all yet" portion of the wait from the "still streaming/reasoning"
      // portion.
      const diagnostics = {
        captchaGraceMs: 0,
        networkErrorRetries: 0,
        continueOrRetryClicks: 0,
        deepThinkStillReasoning: false,
        timeToFirstTextMs: null,
        state: 'no_bubble_yet',
        // Added after observing live (2026-08-14) a run where every failed turn hit the
        // exact same ~180-250s "no progress" timeout, then succeeded in seconds on retry —
        // but the previous diagnostics shape only ever reached the CLI on a successful
        // resolve(), so there was no way to see what the poll loop actually observed during
        // a failure. pollTickCount proves whether polling was even running (vs. throttled to
        // near-zero, e.g. by tab/window backgrounding); bubbleCountAtEnd/baselineCount let a
        // reviewer check whether a NEW bubble was ever recognized at all.
        pollTickCount: 0,
      };

      // Attaches the diagnostics snapshot (plus a final DOM read) to a rejection so a
      // timeout/failure is no less informative than a success — see the diagnostics
      // pollTickCount comment above for why this exists. Every reject() in this function
      // routes through here instead of a bare `new Error(...)`.
      function rejectWithDiagnostics(message) {
        const assistantMsgsNow = document.querySelectorAll(SELECTORS.assistantMessage);
        const currentLastNodeNow = assistantMsgsNow.length ? assistantMsgsNow[assistantMsgsNow.length - 1] : null;
        const lastNow = baselineLastNode
          ? (currentLastNodeNow && currentLastNodeNow !== baselineLastNode ? currentLastNodeNow : null)
          : (assistantMsgsNow.length > baselineCount ? currentLastNodeNow : null);
        diagnostics.bubbleCountAtEnd = assistantMsgsNow.length;
        diagnostics.baselineCount = baselineCount;
        diagnostics.foundNewBubble = !!lastNow;
        diagnostics.lastBubbleTextLenAtEnd = lastNow ? messageText(lastNow).length : 0;
        const err = new Error(message);
        err.diagnostics = diagnostics;
        reject(err);
      }

      (function poll() {
        diagnostics.pollTickCount++;
        if (Date.now() - lastRefocusCheckAt >= REFOCUS_CHECK_INTERVAL_MS) {
          const windowElapsedMs = Date.now() - lastRefocusCheckAt;
          const ticksThisWindow = diagnostics.pollTickCount - ticksAtLastRefocusCheck;
          const observedMsPerTick = ticksThisWindow > 0 ? windowElapsedMs / ticksThisWindow : Infinity;
          lastRefocusCheckAt = Date.now();
          ticksAtLastRefocusCheck = diagnostics.pollTickCount;
          if (observedMsPerTick > HEALTHY_MS_PER_TICK) {
            try {
              chrome.runtime.sendMessage({ action: 'refocusTab' }).catch(() => {});
            } catch (_) {
              // extension context can be briefly unavailable (e.g. mid-reload) — next check retries.
            }
          }
        }
        // Unlike the network-error banner below, this never clears on its own — the chat is
        // genuinely full, so no grace/retry period makes sense here. Distinct wording so
        // orchestrator.js's sendAndTrack can recognize it specifically and migrate to a
        // fresh tab instead of treating it as an ordinary task-ending error (see tabs.js's
        // NOT_RETRYABLE_RE — resending into a full chat can't ever succeed either).
        if (hasLengthLimitReached()) {
          return rejectWithDiagnostics('DeepSeek chat length limit reached — this chat has run out of context and needs a fresh tab.');
        }
        // Observed live (2026-08-13): this fired on a real task even though the user has
        // never once seen an actual CAPTCHA on DeepSeek in a year of manual use. Root cause —
        // Cloudflare's invisible "managed challenge" briefly renders this exact text
        // ("verify you are human...") while a background token check runs, then clears
        // itself in a few seconds with no human action at all. So this can't reject on the
        // first sighting like the iframe-visibility check already guards against; it needs
        // the same grace-and-retry treatment as the network error banner below, and only
        // becomes fatal if the text is still there after CAPTCHA_GRACE_MS.
        if (hasCaptchaChallenge()) {
          if (captchaSince === null) {
            captchaSince = Date.now();
            console.warn('[MyClaudeCode] Possible CAPTCHA text detected, waiting to see if it clears on its own.');
          }
          diagnostics.captchaGraceMs = Date.now() - captchaSince;
          if (Date.now() - captchaSince > CAPTCHA_GRACE_MS) {
            return rejectWithDiagnostics('DeepSeek presented a CAPTCHA challenge — manual intervention required. Please solve it in the browser tab, then retry the task.');
          }
          setTimeout(poll, CAPTCHA_POLL_INTERVAL_MS);
          return;
        }
        captchaSince = null;
        if (hasNetworkErrorBanner()) {
          if (networkErrorSince === null) {
            networkErrorSince = Date.now();
            console.warn('[MyClaudeCode] Network error banner detected, will retry reconnecting.');
          }
          diagnostics.networkErrorRetries++;
          diagnostics.state = 'network_error_retrying';
          // Previously this state was only ever waited out passively (poll until the banner
          // disappears on its own, or give up after NETWORK_ERROR_GRACE_MS) — on the
          // assumption DeepSeek's own client would reconnect by itself. Actively clicking its
          // retry button instead (same button/selector as findRetryButton — see that
          // function's comment) pokes the UI's own recovery path rather than just hoping,
          // same reasoning as the Stopped-badge retry click above. Findable/clickable on
          // every tick this banner is still up (not just the first) — cheap, and a UI that's
          // already mid-retry typically no-ops or disables the button anyway, so repeat
          // clicks aren't expected to cause harm.
          const networkRetryBtn = findRetryButton();
          if (networkRetryBtn) robustClick(networkRetryBtn);
          if (Date.now() - networkErrorSince > NETWORK_ERROR_GRACE_MS) {
            return rejectWithDiagnostics('DeepSeek reported a network error mid-response ("Check network and retry.") that did not clear up. Check your internet connection and try again.');
          }
          setTimeout(poll, NETWORK_ERROR_RETRY_INTERVAL_MS);
          return;
        }
        networkErrorSince = null;

        const continueBtn = findContinueButton();
        const retryBtn = !continueBtn && findRetryButton();
        // The "Stopped" badge (see hasStoppedGenerationBadge) can appear BEFORE any assistant
        // message bubble even exists in the DOM at all — observed live (2026-08-15): a
        // DeepThink trace that stopped mid-reasoning with no real answer never gets
        // `.ds-assistant-message-main-content` created (see SELECTORS.assistantMessage), so
        // bubbleCountAtEnd stayed 0 for the entire ~180s wait and this never got detected at
        // all (it used to only be checked inside `if (last) {...}` below, which never runs
        // when there's no bubble). Checked here instead, unconditionally alongside Continue/
        // Retry, scoped to the LAST `.ds-message` in the DOM rather than the whole document —
        // narrow enough that a stale badge from an already-finished earlier turn can't
        // false-positive a later one (the most recently appended message container is, in
        // practice, always the one this wait is actually about), but doesn't require a
        // populated assistant-content bubble to exist first the way the old scoping did.
        const stoppedBadgeContainer = !continueBtn && !retryBtn ? lastMessageContainer() : null;
        const stoppedRetryBtn =
          stoppedBadgeContainer && hasStoppedGenerationBadge(stoppedBadgeContainer) && diagnostics.continueOrRetryClicks < STOPPED_RETRY_MAX_CLICKS
            ? findStoppedRetryButton()
            : null;
        if (continueBtn || retryBtn || stoppedRetryBtn) {
          const label = continueBtn ? 'Continue' : retryBtn ? 'Retry' : 'Stopped-badge retry';
          console.log(`[MyClaudeCode] ${label} button detected, clicking.`);
          diagnostics.continueOrRetryClicks++;
          robustClick(continueBtn || retryBtn || stoppedRetryBtn);
          // More content is about to stream in — don't let stale stabilization state
          // resolve early on the text as it stood before the click.
          lastText = null;
          lastChangeAt = Date.now();
          lastProgressAt = Date.now();
          if (Date.now() > absoluteDeadline) {
            return rejectWithDiagnostics('Timed out waiting for assistant response (absolute ceiling).');
          }
          setTimeout(poll, 250);
          return;
        }

        const assistantMsgs = document.querySelectorAll(SELECTORS.assistantMessage);
        // Nothing to read yet — a new bubble for THIS turn hasn't appeared in the DOM at
        // all. Deliberately do not fall back to the previous (baselineCount-th) bubble here;
        // that's exactly the stale-response bug described above.
        //
        // Identity-based, not just count-based: observed live (2026-08-15) a real timeout
        // where DeepSeek had already finished and shown its answer, but bubbleCountAtEnd (2)
        // came back LOWER than baselineCount (3) — the chat UI had unmounted an older bubble
        // (virtualized/re-rendered) while this turn was in flight. A pure `length >
        // baselineCount` check then never recovers: it can only re-trigger once the list
        // regrows past the ORIGINAL baseline, which may never happen again this turn, so the
        // response sits fully rendered in the DOM while this stays stuck at 'no_bubble_yet'
        // until the timeout. Comparing the actual last node's identity against the one
        // captured at baseline (see typeAndSend/editMessage) survives that: it only cares
        // whether the current last bubble IS the same element as before sending, regardless
        // of how many older bubbles came or went around it. Falls back to the old count
        // check when no baseline node was captured (defensive default for baselineLastNode).
        const currentLastNode = assistantMsgs.length ? assistantMsgs[assistantMsgs.length - 1] : null;
        const last = baselineLastNode
          ? (currentLastNode && currentLastNode !== baselineLastNode ? currentLastNode : null)
          : (assistantMsgs.length > baselineCount ? currentLastNode : null);

        if (last) {
          if (last.classList.contains('done')) {
            diagnostics.state = 'done';
            return resolve({ text: messageText(last), diagnostics });
          }
          // The "Stopped" badge is handled unconditionally now, near the top of poll()
          // alongside Continue/Retry (see stoppedRetryBtn/lastMessageContainer above) — that
          // check runs BEFORE `last` is even computed, so it covers this bubble too (it's
          // always a descendant of the same `.ds-message` that check scopes to). Used to live
          // here instead, gated on `!last.classList.contains('generating')` — removed after
          // two real failures showed that gate was actively harmful: (1) a cut-off stream can
          // leave `generating` stuck true, silently hiding a real Stopped badge from this
          // branch for the full inactivity timeout (2026-08-15, ~177s); (2) a stopped
          // DeepThink trace with no real answer never gets SELECTORS.assistantMessage's
          // element created at all, so `last` stays null and this whole `if (last)` block
          // — badge check included — never ran in the first place.
          const stillThinking = hasActiveThinkingIndicator(last);
          if (stillThinking) diagnostics.deepThinkStillReasoning = true;
          if (!last.classList.contains('generating')) {
            const text = messageText(last);
            if (text) {
              if (!sawAnyText) diagnostics.timeToFirstTextMs = Date.now() - pollStartedAt;
              sawAnyText = true;
              if (text !== lastText) {
                diagnostics.state = 'streaming';
                lastText = text;
                lastChangeAt = Date.now();
                lastProgressAt = Date.now();
                buttonWaitSince = null;
              } else if (stillThinking) {
                // Text hasn't changed, but DeepThink is still actively reasoning (no
                // "Stopped" badge) — treat this exactly like ongoing progress rather than
                // resolving on a frozen mid-thought fragment or letting it count toward the
                // (much shorter) inactivity timeout below.
                diagnostics.state = 'thinking_no_new_text';
                lastProgressAt = Date.now();
              } else {
                // Ground-truth fast path: the network stream for THIS turn (lastStreamDoneAt
                // set after pollStartedAt, so it can't be a stale signal left over from a
                // previous turn) already closed. Originally also required
                // `lastStreamDoneAt >= lastChangeAt` — closed at or after the last DOM text
                // change — reasoning that a stream closing before the DOM finished updating
                // couldn't be trusted yet. Live testing (2026-08-14, full CLI run against the
                // real site) showed that requirement made the fast path NEVER fire: every
                // single successful turn resolved via the plain 'done' state, none via
                // 'done_stream_confirmed' — the final tokens routinely paint to the DOM some
                // ms AFTER the network stream that carried them has already closed, so
                // lastStreamDoneAt was consistently a hair earlier than lastChangeAt and the
                // comparison failed every time. Dropped: the network closing at all during
                // this turn is still strong evidence generation is over, and the
                // `Date.now() - lastChangeAt >= requiredStableMs` check right below still
                // requires the DOM to have gone quiet too — a stream-done signal alone can
                // never resolve early on its own, it only shortens how long the DOM-quiet
                // wait needs to be.
                const streamConfirmedDone = lastStreamDoneAt > pollStartedAt;
                const requiredStableMs = streamConfirmedDone ? STREAM_CONFIRMED_STABLE_MS : STABLE_MS;
                const buttonGraceMs = streamConfirmedDone ? STREAM_CONFIRMED_BUTTON_GRACE_MS : BUTTON_READY_GRACE_MS;
                // Diagnostic-only (rides along in the TIMING message content.js's caller
                // already surfaces to the CLI) — added after live testing showed
                // done_stream_confirmed never firing in real orchestrator runs despite the
                // signal being proven to arrive in a manual test. Without visibility into
                // WHY, further tuning here is just guessing. streamSignalSeen mirrors
                // streamConfirmedDone at every poll tick (last value wins by resolve time);
                // streamVsTextChangeGapMs is negative when the network stream closed BEFORE
                // the last DOM text change (expected/healthy — see the comment above) and
                // positive if the DOM went quiet before the stream signal ever arrived at all
                // (would explain a real miss, e.g. webRequest→content.js message latency in a
                // backgrounded/throttled tab losing the race against requiredStableMs).
                diagnostics.streamSignalSeen = streamConfirmedDone;
                diagnostics.streamVsTextChangeGapMs = lastStreamDoneAt > 0 ? lastStreamDoneAt - lastChangeAt : null;

                if (Date.now() - lastChangeAt >= requiredStableMs) {
                  // Text alone has been quiet long enough, but confirm DeepSeek's own UI
                  // agrees it's finished — the send button re-enabling — before trusting it.
                  // A brief mid-response pause (still disabled) must not resolve early; treat
                  // that as ongoing progress, not a stall, so it doesn't eat into the
                  // inactivity budget.
                  if (isSendButtonDisabled()) {
                    if (buttonWaitSince === null) buttonWaitSince = Date.now();
                    if (Date.now() - buttonWaitSince > buttonGraceMs) {
                      console.warn('[MyClaudeCode] Send button never confirmed ready after stable text — trusting text-stabilization alone (selector may be stale).');
                      diagnostics.state = 'done';
                      return resolve({ text, diagnostics });
                    }
                    diagnostics.state = 'text_stable_awaiting_button_ready';
                    lastProgressAt = Date.now();
                  } else {
                    diagnostics.state = streamConfirmedDone ? 'done_stream_confirmed' : 'done';
                    return resolve({ text, diagnostics });
                  }
                } else {
                  diagnostics.state = 'stabilizing';
                }
              }
            }
          }
        } else {
          diagnostics.state = 'no_bubble_yet';
        }

        const effectiveTimeout = sawAnyText && !hasActiveThinkingIndicator(last) ? inactivityTimeoutMs : INITIAL_RESPONSE_GRACE_MS;
        if (Date.now() - lastProgressAt > effectiveTimeout) {
          return rejectWithDiagnostics('Timed out waiting for assistant response (no progress).');
        }
        if (Date.now() > absoluteDeadline) {
          return rejectWithDiagnostics('Timed out waiting for assistant response (absolute ceiling).');
        }
        setTimeout(poll, 250);
      })();
    });
  }

  // Observed live (2026-08-10): on a freshly created tab, a plain sendButton.click() can
  // silently do nothing — waitForReadyState only confirms the textarea exists and isn't
  // disabled, which is a shallow signal; the page's own JS framework can still be mid-
  // hydration and not yet have its real click handler attached to the send button (same
  // class of problem robustClick's own comment already documents for the Continue/Retry
  // buttons — the send button just never got the same treatment). When that happens, no
  // message is ever actually submitted, no new assistant bubble ever appears, and
  // waitForAssistantSettle polls all the way to a timeout for a send that never happened —
  // indistinguishable, from the outside, from DeepSeek simply never responding. Confirm the
  // click actually registered (the textarea clearing is DeepSeek's own immediate feedback
  // that a message was submitted) and retry the click itself, a few times, before ever
  // starting the long response-wait.
  // Budget: 8 attempts * 3s = ~24s total. Deliberately much more generous than the original
  // 4*1.5s=6s — observed live (2026-08-11): that shorter budget could itself misfire on a
  // freshly created tab that was just genuinely slow to finish hydrating, throwing this
  // error for what would have worked fine given a bit more time. Still nowhere near
  // INITIAL_RESPONSE_GRACE_MS (3 minutes) — this only needs to cover "framework not
  // attached yet", not "DeepSeek hasn't started answering yet" (that's
  // waitForAssistantSettle's job, once the send itself is confirmed).
  // baselineUserCount lets this tell "the click worked but the textarea is just slow to
  // clear" apart from "the click never registered at all" — relying on textarea.value alone
  // meant a slow-clearing (but genuinely successful) first click got re-clicked on attempt 2,
  // submitting the same message twice (and, for a !SHELL command, effectively running it
  // twice). A new user message actually appearing in the DOM is the one signal that can't
  // happen without a real, already-successful send, so it short-circuits the retry loop even
  // if the textarea hasn't visually cleared yet.
  // generous mode: for a large pasted message (the executor/planner primer, routinely
  // several KB once the project file list + memory.md content are appended), DeepSeek's own
  // UI can take meaningfully longer to finish processing the pasted value before the send
  // button's click handler is actually responsive — the response side already grants a much
  // longer grace period for exactly this reason (INITIAL_RESPONSE_GRACE_MS, 3 minutes above).
  // Observed live (2026-08-11): the fixed 8*3s=24s budget below, tuned against short typed
  // messages, reported "did not appear to submit" and threw on the executor primer — even
  // though the message had genuinely gone through and DeepSeek was already replying to it in
  // the tab. Fixed here by widening the per-attempt window (not just adding more attempts at
  // the same short cadence), specifically so a slow-but-working UI gets more time to settle
  // BEFORE we conclude the click failed and re-click — cranking up attempt *count* alone
  // would mean re-clicking (and risking a duplicate send) more eagerly, the opposite of what
  // a slow UI needs.
  // Observed live (2026-08-11): after the timing widening above, the executor primer still
  // failed ALL 8 attempts, uniformly, across multiple separate task runs — not the flaky
  // "sometimes needs one more retry" pattern a genuine timing issue produces. A click that
  // fails identically every single time, with zero partial progress, is the signature of
  // clicking a STALE DOM reference: if DeepSeek swaps the send button for a different
  // element once the textarea goes from empty to non-empty (a common pattern — a disabled-
  // state control and an enabled-state one as genuinely separate DOM nodes, not the same
  // node with a toggled attribute), the `sendButton`/`textarea` elements captured once at
  // the top of typeAndSend, *before* the paste, are already detached from the live tree by
  // the time we click them here — every retry then clicks the same dead node. Re-query both
  // fresh on every attempt instead of trusting the caller's captured references; falls back
  // to the last-known element if a fresh query transiently returns nothing (e.g. mid-
  // re-render) rather than crashing the whole send over one bad tick.
  async function clickSendAndConfirm(sendButton, textarea, baselineUserCount, { generous = false } = {}) {
    const ATTEMPTS = 8;
    const CHECK_INTERVAL_MS = 300;
    const CHECK_WINDOW_MS = generous ? 8000 : 3000;
    let liveButton = sendButton;
    let liveTextarea = textarea;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const freshButton = query(SELECTORS.sendButton);
      // Diagnostic for the stale-reference theory above: if this ever logs "true" on a run
      // that still fails, that confirms DeepSeek really is swapping the button element —
      // if it logs "false" and it still fails, the cause is something else and this
      // particular fix didn't address it. Only worth checking once per send, not every
      // attempt.
      if (attempt === 1 && freshButton && freshButton !== liveButton) {
        console.warn('[MyClaudeCode] Send button element changed since it was first queried (stale-reference fix engaged).');
      }
      liveButton = freshButton || liveButton;
      liveTextarea = query(SELECTORS.textarea) || liveTextarea;
      robustClick(liveButton);
      const start = Date.now();
      while (Date.now() - start < CHECK_WINDOW_MS) {
        await sleep(CHECK_INTERVAL_MS);
        liveTextarea = query(SELECTORS.textarea) || liveTextarea;
        if (!liveTextarea.value || getUserMessageEls().length > baselineUserCount) return;
      }
      console.warn(
        `[MyClaudeCode] Send click ${attempt}/${ATTEMPTS} didn't appear to submit (input still has text) — retrying.`
      );
    }
    throw new Error('Clicking send did not appear to submit the message (input was never cleared) after multiple attempts.');
  }

  async function typeAndSend(text, { instant = false } = {}) {
    await waitForReadyState();
    if (hasLengthLimitReached()) {
      throw new Error('DeepSeek chat length limit reached — this chat has run out of context and needs a fresh tab.');
    }
    // Same grace-and-retry treatment as waitForAssistantSettle's poll loop — a transient
    // Cloudflare managed-challenge text can be present for a couple seconds here too.
    if (hasCaptchaChallenge()) {
      const deadline = Date.now() + CAPTCHA_GRACE_MS;
      while (hasCaptchaChallenge() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, CAPTCHA_POLL_INTERVAL_MS));
      }
      if (hasCaptchaChallenge()) {
        throw new Error('DeepSeek presented a CAPTCHA challenge — manual intervention required. Please solve it in the browser tab, then retry the task.');
      }
    }
    await clearStuckButtons();
    const textarea = query(SELECTORS.textarea);
    const sendButton = query(SELECTORS.sendButton);
    if (!textarea || !sendButton) throw new Error('Could not locate chat input or send button.');

    const baselineMsgsAtSend = document.querySelectorAll(SELECTORS.assistantMessage);
    const baselineCount = baselineMsgsAtSend.length;
    const baselineLastNode = baselineMsgsAtSend.length ? baselineMsgsAtSend[baselineMsgsAtSend.length - 1] : null;
    const baselineUserCount = getUserMessageEls().length;
    const estimatedTypingMs = (text.length / AVG_CHUNK_CHARS) * ((50 + 150) / 2);
    // Same condition typeIntoElement itself uses to decide paste-vs-type (see above) —
    // recomputed here rather than threaded back out of it, since typeAndSend already knows
    // `instant` and text.length and this is a one-line check.
    const wasPasted = instant || estimatedTypingMs > TYPE_TIME_BUDGET_MS;
    await typeIntoElement(textarea, text, { instant });
    await sleep(randomBetween(200, 800));
    // Give the button a bounded window to re-enable if it's still mid-transition from the
    // previous turn (see isSendButtonDisabled's comment) — clicking a disabled button is a
    // silent no-op, which is exactly what clickSendAndConfirm's own retry loop is built to
    // recover from, but recovering there costs multiple 3-8s click-and-wait cycles. Checking
    // first is cheap and avoids paying that cost on the common case.
    const SEND_READY_POLL_MS = 2000;
    const SEND_READY_TIMEOUT_MS = 20000;
    const readyDeadline = Date.now() + SEND_READY_TIMEOUT_MS;
    while (isSendButtonDisabled() && Date.now() < readyDeadline) {
      await sleep(SEND_READY_POLL_MS);
    }
    await clickSendAndConfirm(sendButton, textarea, baselineUserCount, { generous: wasPasted });

    const reply = await waitForAssistantSettle(baselineCount, undefined, baselineLastNode);
    return { text: reply.text, diagnostics: reply.diagnostics };
  }

  function extractLastResponse() {
    const assistantMsgs = document.querySelectorAll(SELECTORS.assistantMessage);
    const last = assistantMsgs[assistantMsgs.length - 1];
    if (!last) return { text: '' };
    return { text: messageText(last) };
  }

  // Real-site edit UI is hover-revealed (readme.md section 9's migration flow needs this
  // to find and click a message's edit pencil), and its icon buttons carry no aria-label
  // or data-testid — see EDIT_ICON_PATH_PREFIX / findButtonByIconPath above for how those
  // get identified. Confirmed against actual chat.deepseek.com outerHTML.
  async function editMessage(index, newText) {
    // `index` is computed by the caller from an internal running message
    // counter, which assumes every historical message is still present in
    // the DOM. Real chat sites can virtualize/unmount older messages as the
    // conversation scrolls, so that counter can outrun what's actually
    // rendered. Clamp to the nearest message actually present rather than
    // hard-failing the whole task over a stale index.
    const userMsgs = getUserMessageEls();
    if (!userMsgs.length) throw new Error('No user messages found in the DOM to edit.');
    const safeIndex = Math.min(Math.max(0, index), userMsgs.length - 1);
    const target = userMsgs[safeIndex];
    if (!target) throw new Error(`No user message at index ${index} to edit.`);

    // The edit pencil only renders in the DOM on hover on the real site.
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await sleep(150);

    const editBtn =
      target.querySelector(SELECTORS.editButton) ||
      findButtonByIconPath(target, EDIT_ICON_PATH_PREFIX) ||
      findButtonByIconPath(document, EDIT_ICON_PATH_PREFIX);
    if (!editBtn) throw new Error('Edit button not found on target message.');
    editBtn.click();
    await sleep(150);

    const textarea = target.querySelector('textarea') || query(SELECTORS.editTextarea);
    if (!textarea) throw new Error('Edit textarea did not appear.');
    await typeIntoElement(textarea, newText);

    const saveBtn =
      Array.from(target.querySelectorAll('button')).find((b) => /save/i.test(b.textContent)) ||
      findButtonByText(target, EDIT_SEND_BUTTON_TEXT) ||
      findButtonByText(document, EDIT_SEND_BUTTON_TEXT);
    if (!saveBtn) throw new Error('Save/Send button not found in edit mode.');

    // Same reasoning as clickSendAndConfirm above (a plain .click() can miss a framework's
    // real handler) — no reliable "did it register" signal here the way a cleared textarea
    // confirms a normal send (edit mode's UI just unmounts on success, not a value to poll),
    // so this gets the more reliable click dispatch without the confirm-and-retry loop.
    robustClick(saveBtn);

    // Unlike typeAndSend, the baseline can't be captured before the click: editing a
    // message truncates every later message (including its own original assistant reply)
    // before a new one streams in, so a pre-click count could be equal to or even higher
    // than the eventual real new-response count — "count increased" would never trigger.
    // Give the truncation a moment to actually happen in the DOM, then baseline against
    // what's left (pre-new-response) before waiting for the regenerated reply to appear.
    await sleep(400);
    const baselineMsgsAfterEdit = document.querySelectorAll(SELECTORS.assistantMessage);
    const baselineCount = baselineMsgsAfterEdit.length;
    const baselineLastNode = baselineMsgsAfterEdit.length ? baselineMsgsAfterEdit[baselineMsgsAfterEdit.length - 1] : null;
    const reply = await waitForAssistantSettle(baselineCount, undefined, baselineLastNode);
    return { text: reply.text, diagnostics: reply.diagnostics };
  }

  // DeepSeek's real toggle buttons ("DeepThink" reasoning mode, "Search" web search) share
  // the same hashed classes as everything else, but each has a visible text label in a
  // sibling span — that's the reliable anchor. Confirmed against real outerHTML.
  function findToggleButtonByLabel(label) {
    const candidates = document.querySelectorAll('[aria-pressed]');
    for (const el of candidates) {
      if ((el.textContent || '').trim().toLowerCase() === label.toLowerCase()) return el;
    }
    return null;
  }

  function toggleFeature(mockSelector, realLabel, enabled) {
    const btn = (mockSelector && query(mockSelector)) || findToggleButtonByLabel(realLabel);
    if (!btn) return { toggled: false };
    const pressed = btn.getAttribute('aria-pressed') === 'true';
    if (pressed !== !!enabled) btn.click();
    return { toggled: true };
  }

  function toggleWebSearch(enabled) {
    return toggleFeature(SELECTORS.webSearchToggle, 'Search', enabled);
  }

  function toggleDeepThink(enabled) {
    return toggleFeature(null, 'DeepThink', enabled);
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'typeAndSend') {
      typeAndSend(request.text, { instant: request.instant })
        .then(sendResponse)
        // err.diagnostics (see waitForAssistantSettle's rejectWithDiagnostics) rides along
        // on a failure too now, not just a success — otherwise a timeout crossing this
        // extension-message boundary silently dropped everything except the bare error
        // string, which is exactly what made a repeating timeout-then-quick-success pattern
        // unexplainable from the log alone.
        .catch((err) => sendResponse({ error: err.message, diagnostics: err.diagnostics || null }));
      return true;
    }
    if (request.action === 'extractLastResponse') {
      sendResponse(extractLastResponse());
      return false;
    }
    if (request.action === 'editMessage') {
      editMessage(request.index, request.newText)
        .then(sendResponse)
        // err.diagnostics (see waitForAssistantSettle's rejectWithDiagnostics) rides along
        // on a failure too now, not just a success — otherwise a timeout crossing this
        // extension-message boundary silently dropped everything except the bare error
        // string, which is exactly what made a repeating timeout-then-quick-success pattern
        // unexplainable from the log alone.
        .catch((err) => sendResponse({ error: err.message, diagnostics: err.diagnostics || null }));
      return true;
    }
    if (request.action === 'toggleWebSearch') {
      sendResponse(toggleWebSearch(request.enabled));
      return false;
    }
    if (request.action === 'toggleDeepThink') {
      sendResponse(toggleDeepThink(request.enabled));
      return false;
    }
    if (request.action === 'checkSelectors') {
      // Cheap, non-blocking canary (readme.md section 13's "no automated detection of
      // real-site DOM/selector breakage" gap) — checked once right after a tab becomes
      // ready, so a UI change on chat.deepseek.com's markup surfaces as an immediate,
      // specific warning instead of silently failing (or timing out confusingly) partway
      // through a real task. Only the two selectors every single send depends on
      // (textarea, sendButton) are checked — the rest have their own fallback/near-miss
      // handling already (readme.md section 9/11) and would be noisy false positives here
      // (e.g. webSearchToggle legitimately absent unless web search is enabled).
      const missing = [];
      if (!query(SELECTORS.textarea)) missing.push('textarea');
      if (!query(SELECTORS.sendButton)) missing.push('sendButton');
      sendResponse({ missing });
      return false;
    }
    if (request.action === 'streamCompleted') {
      // Relayed from background.js's chrome.webRequest listener — see its comment for why
      // that replaced the original in-page fetch-patch approach (streamBridge.js): confirmed
      // live that DeepSeek's actual completion request never triggers a page-level
      // window.fetch patch at all (window.fetch.toString() showed 300 real chars of our
      // wrapper installed and working — a direct test call to it fired correctly — yet zero
      // events fired for an actual DeepSeek turn that completed normally). webRequest sees
      // every network request the browser makes for this tab at the network-stack level,
      // regardless of which JS realm (main page, Worker, Service Worker) issued it, so it
      // isn't subject to that blind spot.
      lastStreamDoneAt = request.ts || Date.now();
      console.log('[MyClaudeCode] stream-completed signal received for', request.url, 'at', lastStreamDoneAt);
      return false;
    }
    if (request.action === 'waitForReady') {
      // Short internal budget: TabManager.waitForReady (background) re-sends this message
      // every 300ms in its own retry loop, so one slow/failed attempt here shouldn't eat
      // the whole outer timeout — that's what caused a single "not ready" to look like a
      // 30s hang against the real site.
      waitForReadyState(2000)
        .then(() => sendResponse({ ready: true }))
        .catch((err) => sendResponse({ ready: false, error: err.message }));
      return true;
    }
    return false;
  });
})();
