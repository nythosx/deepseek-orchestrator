// Wraps the persistent chrome.runtime.connectNative port to the native host.
// Loaded into the background service worker via importScripts (classic script,
// shares the global scope — no module system needed).

const NativeBridge = (() => {
  const HOST_ID = 'com.myclaudecode.host';
  let port = null;
  const pendingToolRequests = new Map(); // requestId -> {resolve, reject, port}
  let onCliPayload = () => {};
  let onDisconnect = () => {};
  let lastProfileId = null;

  // Reconnect backoff. The open native port is also what keeps this MV3 service worker
  // alive (Chrome 105+): with no port, Chrome suspends the worker after ~30s idle and every
  // in-memory session in Orchestrator/PhasedRunner is lost — the "Receiving end does not
  // exist" class of failure. So a dropped port is reconnected eagerly rather than lazily on
  // the next tool call, and the cap stays under that 30s idle window.
  const RECONNECT_BASE_MS = 500;
  const RECONNECT_MAX_MS = 20000;
  let reconnectDelayMs = RECONNECT_BASE_MS;
  let reconnectTimer = null;
  let connectedAt = 0;

  function connect() {
    if (port) return port; // already connected/connecting — don't spawn a second host process
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const thisPort = chrome.runtime.connectNative(HOST_ID);
    port = thisPort;
    connectedAt = Date.now();
    thisPort.onMessage.addListener(handleMessage);
    thisPort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      console.warn('[NativeBridge] native host disconnected', err && err.message);
      if (port === thisPort) port = null;
      // The host process that owned these requests is gone; its TOOL_RESULTs will never
      // arrive. Reject instead of leaving the orchestrator awaiting forever. Not retried
      // here: a SHELL/WRITE_FILE may already have run, and only the caller knows whether
      // re-running it is safe.
      const reason = new Error(
        `Native host disconnected before replying${err && err.message ? ` (${err.message})` : ''}.`
      );
      for (const [requestId, pending] of pendingToolRequests) {
        if (pending.port !== thisPort) continue; // sent on a newer port, still in flight
        pendingToolRequests.delete(requestId);
        pending.reject(reason);
      }
      onDisconnect(err);
      scheduleReconnect();
    });
    // A new host process starts with no profileId; resend the last one we had.
    if (lastProfileId) {
      try {
        thisPort.postMessage({ type: 'PROFILE_ID', profileId: lastProfileId });
      } catch (_) {
        // onDisconnect will fire and handle it
      }
    }
    return thisPort;
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    // A port that stayed up for a while was a real connection; start backoff over.
    if (Date.now() - connectedAt > 60000) reconnectDelayMs = RECONNECT_BASE_MS;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
    console.warn(`[NativeBridge] reconnecting to native host in ${delay}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function handleMessage(msg) {
    if (!msg) return;
    if (msg.type === HOST_MESSAGE_TYPES.TOOL_RESULT) {
      const pending = pendingToolRequests.get(msg.requestId);
      if (pending) {
        pendingToolRequests.delete(msg.requestId);
        if (msg.error) pending.reject(new Error(msg.error));
        else pending.resolve(msg.result);
      }
      return;
    }
    if (msg.type === HOST_MESSAGE_TYPES.CLI_TO_EXT) {
      onCliPayload(msg.payload);
      return;
    }
    console.warn('[NativeBridge] unhandled message from host', msg);
  }

  function ensurePort() {
    if (!port) connect();
    return port;
  }

  // postMessage on a port Chrome has already torn down throws synchronously ("Attempting
  // to use a disconnected port object") before onDisconnect has run. Drop it and retry
  // once on a fresh port — the message never left, so resending can't duplicate it.
  // Returns the port the message actually went out on.
  function post(msg) {
    const first = ensurePort();
    try {
      first.postMessage(msg);
      return first;
    } catch (err) {
      console.warn('[NativeBridge] post failed, retrying on a fresh port:', err && err.message);
      if (port === first) port = null;
      const fresh = ensurePort();
      fresh.postMessage(msg);
      return fresh;
    }
  }

  function execTool(taskId, tool, params) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, port: null };
      pendingToolRequests.set(requestId, pending);
      try {
        pending.port = post({ type: HOST_MESSAGE_TYPES.EXEC_TOOL, taskId, tool, params, requestId });
      } catch (err) {
        pendingToolRequests.delete(requestId);
        reject(err);
      }
    });
  }

  function sendToCli(payload) {
    post({ type: HOST_MESSAGE_TYPES.EXT_TO_CLI, payload });
  }

  function setOnCliPayload(fn) {
    onCliPayload = fn;
  }

  function setOnDisconnect(fn) {
    onDisconnect = fn;
  }

  // Sent once at service-worker startup (see background.js's ensureProfileId), received
  // by host.js as a native message, forwarded by host.js to the CLI in every HELLO_ACK.
  // Best-effort: if the native host isn't installed yet, this logs and moves on — the
  // profileId will be sent on the next service-worker wake-up, which is fine, since it's
  // only needed for cross-profile routing (v2) and every v1 connection works without it.
  function sendProfileId(profileId) {
    lastProfileId = profileId || null;
    try {
      post({ type: 'PROFILE_ID', profileId: profileId || null });
    } catch (err) {
      console.warn('[NativeBridge] could not send profileId:', err && err.message);
    }
  }

  return { connect, execTool, sendToCli, sendProfileId, setOnCliPayload, setOnDisconnect, ensurePort };
})();
