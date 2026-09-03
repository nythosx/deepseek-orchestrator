// Wraps the persistent chrome.runtime.connectNative port to the native host.
// Loaded into the background service worker via importScripts (classic script,
// shares the global scope — no module system needed).

const NativeBridge = (() => {
  const HOST_ID = 'com.myclaudecode.host';
  let port = null;
  const pendingToolRequests = new Map(); // requestId -> {resolve, reject}
  let onCliPayload = () => {};
  let onDisconnect = () => {};

  function connect() {
    if (port) return port; // already connected/connecting — don't spawn a second host process
    port = chrome.runtime.connectNative(HOST_ID);
    port.onMessage.addListener(handleMessage);
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      console.warn('[NativeBridge] native host disconnected', err && err.message);
      port = null;
      onDisconnect(err);
    });
    return port;
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

  function execTool(taskId, tool, params) {
    ensurePort();
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      pendingToolRequests.set(requestId, { resolve, reject });
      port.postMessage({ type: HOST_MESSAGE_TYPES.EXEC_TOOL, taskId, tool, params, requestId });
    });
  }

  function sendToCli(payload) {
    ensurePort();
    port.postMessage({ type: HOST_MESSAGE_TYPES.EXT_TO_CLI, payload });
  }

  function setOnCliPayload(fn) {
    onCliPayload = fn;
  }

  function setOnDisconnect(fn) {
    onDisconnect = fn;
  }

  return { connect, execTool, sendToCli, setOnCliPayload, setOnDisconnect, ensurePort };
})();
