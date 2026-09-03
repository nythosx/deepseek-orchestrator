// Local, loopback-only HTTP server for the live process dashboard (see readme "--dashboard").
// Not the same server as cli/lib/server.js (that one's the WebSocket bridge the extension's
// native host connects to for actually running the task) — this one just serves a single
// static page plus a Server-Sent Events feed of the exact same --json event stream, so the
// dashboard can render in a normal browser tab, right next to the DeepSeek planner/executor
// tabs, and update live with zero polling.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

function buildPage() {
  const reducerSrc = fs.readFileSync(path.join(__dirname, 'stepReducer.js'), 'utf8');
  const pageTemplate = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');
  return pageTemplate.replace('/*__STEP_REDUCER__*/', reducerSrc);
}

function openInBrowser(url) {
  // Windows: `start` is a cmd.exe builtin, not an executable — must go through the shell.
  // The empty "" first argument is `start`'s own window-title parameter; without it, a URL
  // containing certain characters gets misread as the title instead of the target.
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

/**
 * Starts the dashboard server and returns { url, push, close }.
 * push(event) fans the event out to every currently-connected browser tab (usually zero or
 * one, but nothing stops multiple people/tabs from watching the same run).
 */
async function startDashboard({ open = true } = {}) {
  const page = buildPage();
  const clients = new Set();

  // Everything ever pushed, kept for the life of the process. Two real gaps this closes:
  // (1) the browser tab takes a moment to open and connect its EventSource after
  // openInBrowser() fires — any event pushed in that window used to just vanish, since a
  // client-less push() was a no-op; (2) a tab that Chrome freezes/discards in the
  // background (observed live, 2026-08-15: dashboard stuck on a stale step while the real
  // run kept going) has no way to catch up on reconnect — a fresh EventSource only ever
  // got events pushed *after* it connected. Every new connection now replays this whole
  // history before joining the live feed, so "reconnect" and "catch up" are the same thing.
  // Uncapped is fine here: one CLI run produces on the order of dozens to a few hundred
  // small JSON events, not an unbounded stream.
  const history = [];

  function frame(event) {
    return `data: ${JSON.stringify(event)}\n\n`;
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      for (const event of history) res.write(frame(event));
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;

  function push(event) {
    history.push(event);
    if (!clients.size) return;
    const data = frame(event);
    for (const res of clients) {
      try { res.write(data); } catch (_) { /* client gone, req 'close' will clean it up */ }
    }
  }

  // A comment-only line (ignored by EventSource's onmessage, per spec) every 15s. Keeps the
  // loopback connection visibly alive through anything that might otherwise time out an
  // idle socket, and gives a frozen/suspended tab a steady drip of activity to resume on.
  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try { res.write(': ping\n\n'); } catch (_) {}
    }
  }, 15000);
  heartbeat.unref();

  if (open) openInBrowser(url);

  return {
    url,
    push,
    close: () => { clearInterval(heartbeat); try { server.close(); } catch (_) {} },
  };
}

module.exports = { startDashboard };
