const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { HOST_MESSAGE_TYPES } = require('../../shared/protocol');

// How long a connecting client gets to echo the handshake token back before it's given up on
// and closed — generous, since this is local-loopback and should resolve near-instantly for
// the real native host; mainly guards against a connection that never replies at all.
const HANDSHAKE_TIMEOUT_MS = 3000;

const PREFERRED_PORT = 9876;
const WELL_KNOWN_DIR = path.join(os.homedir(), '.myclaudecode');

// Observed live (2026-08-13): a completely unrelated project on the same machine, built
// from the same "MyClaudeCode" template, independently landed on the exact same discovery
// path (`~/.myclaudecode/current_port`) — a single, user-global file with no way to tell
// which installation's native host should actually be polling it. Both native hosts ended
// up racing to connect to whichever CLI wrote there, with no way to tell from the outside
// which one a given CLI run actually talked to (see readme.md section 13, and the
// native-host/host.js side of this same fix).
//
// The fix: derive an id from THIS INSTALLATION's own on-disk path (not the target project
// the user happens to be running the CLI from — that's a different, unrelated "project"
// concept and varies per task) and fold it into the discovery filename. Two separate
// checkouts of this same codebase (this repo cloned twice, or a sibling project built from
// the same template) live at different absolute paths, so they get different discovery
// files automatically — no config, no manual naming scheme to keep in sync by hand. Two
// *processes from the same checkout* still correctly share one file, which is the only case
// where sharing was ever actually intended (one native host discovering one CLI).
const INSTALL_ID = crypto.createHash('sha256').update(path.resolve(__dirname, '..', '..')).digest('hex').slice(0, 12);
const PORT_FILE = path.join(WELL_KNOWN_DIR, `current_port_${INSTALL_ID}`);

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  if (await isPortFree(PREFERRED_PORT)) return PREFERRED_PORT;
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.once('error', reject);
    tester.listen(0, '127.0.0.1', () => {
      const { port } = tester.address();
      tester.close(() => resolve(port));
    });
  });
}

function writePortFile(port) {
  fs.mkdirSync(WELL_KNOWN_DIR, { recursive: true });
  fs.writeFileSync(PORT_FILE, String(port));
}

function cleanupPortFile() {
  try {
    if (fs.existsSync(PORT_FILE)) fs.unlinkSync(PORT_FILE);
  } catch (_) {
    // best-effort cleanup
  }
}

/**
 * Starts the local WS server the native host connects to.
 * Resolves with { port, wss, waitForConnection } once listening.
 */
async function startServer() {
  const port = await pickPort();
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  writePortFile(port);

  // A well-known local TCP port can be connected to by literally any process on the
  // machine, not just this project's own native host (see HOST_MESSAGE_TYPES.HELLO's
  // comment for the live incident this fixes) — so every connection has to prove it's the
  // real thing before being trusted. Each connection gets one shot: sent a HELLO with a
  // random per-server token, and either echoes it back via HELLO_ACK within
  // HANDSHAKE_TIMEOUT_MS (accepted) or doesn't (closed, and the wait continues for the
  // next attempt). A stray/unrelated process that doesn't speak this handshake at all just
  // silently fails verification and gets dropped — indistinguishable, from its own
  // perspective, from the port simply not answering the way it expected.
  const sessionToken = crypto.randomUUID();

  // Observed live (2026-08-13), intermittent ~50% failure: the native host polls and
  // reconnects on its own schedule, independent of when this module's caller gets around to
  // calling waitForConnection() below — and `wss` starts accepting connections as soon as
  // it's constructed above, not when waitForConnection() is later called. If a connection
  // (and thus wss's 'connection' event) arrived in that gap, a `wss.once('connection', ...)`
  // registered only inside waitForConnection() would already be too late — the event fires
  // once, with no listener attached, and is gone forever. The native host then just sits
  // there successfully connected while the CLI waits on a "next" connection event that will
  // never come (the host won't reconnect since, from its side, it's already OPEN). Fixed by
  // attaching the real `wss.on('connection', ...)` handler unconditionally, right here,
  // before this function even returns — every connection gets handshake-checked the moment
  // it happens, regardless of whether waitForConnection() has been called yet. A connection
  // that completes the handshake before anyone's awaiting it is queued in `readyConnection`
  // and handed to the first subsequent waitForConnection() call immediately.
  let readyConnection = null;
  let pendingResolve = null;

  function attemptHandshake(ws) {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.removeListener('message', onMessage);
      ws.close();
      // No retry loop needed here — every future connection also hits this same handler.
    }, HANDSHAKE_TIMEOUT_MS);

    function onMessage(raw) {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (_) {
        return; // not JSON at all — definitely not our handshake reply
      }
      if (msg.type !== HOST_MESSAGE_TYPES.HELLO_ACK || msg.token !== sessionToken) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      // profileId: attached by host.js from the extension's chrome.storage.local (see
      // background.js's ensureProfileId). Null on a race-y first handshake is tolerated —
      // v1 doesn't actually require it, and the next reconnect will have it. Only relevant
      // to v2's cross-profile routing, but attaching it here is the cheapest way to make
      // that a clean additive change later rather than a refactor.
      ws.profileId = (msg && msg.profileId) || null;
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve(ws);
      } else {
        readyConnection = ws;
      }
    }
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: HOST_MESSAGE_TYPES.HELLO, token: sessionToken }));
  }

  wss.on('connection', attemptHandshake);

  const waitForConnection = () =>
    new Promise((resolve) => {
      if (readyConnection) {
        const ws = readyConnection;
        readyConnection = null;
        resolve(ws);
        return;
      }
      pendingResolve = resolve;
    });

  return { port, wss, waitForConnection };
}

module.exports = { startServer, cleanupPortFile, PORT_FILE };
