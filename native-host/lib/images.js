// Image attachment support (RESOLVE_IMAGE / READ_IMAGE_CHUNK).
//
// RESOLVE_IMAGE turns whatever the user or brain wrote -- an absolute or relative path, a
// bare file name, an http(s) URL, or a clipboard token like "[Image #3]" -- into one real
// image file on disk, trying in order: clipboard -> URL download -> the path as given ->
// a search of the project by file name. One call, so the brain never has to chain
// "test -f", "cp" and "find" commands (and get Windows quoting wrong in between).
//
// The bytes come back separately through READ_IMAGE_CHUNK because Chrome caps a single
// native-messaging message from the host at 1 MB, and a screenshot's base64 alone can
// exceed that. Only files RESOLVE_IMAGE handed out can be read that way.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// A multiple of 3, so each chunk's base64 has no padding and chunks concatenate cleanly.
const CHUNK_BYTES = 3 * 170000;
const SEARCH_SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', '.myclaudecode', 'dist', 'build', '.next', '.cache']);
const SEARCH_MAX_ENTRIES = 50000;
const URL_TIMEOUT_MS = 15000;
const CLIPBOARD_TOKEN_RE = /^\[?(image|screenshot|clipboard|pasted image)(\s*#\s*\d+)?\]?$/i;

const resolvedPaths = new Set();

function tempDir() {
  const dir = path.join(os.tmpdir(), 'myclaudecode-images');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function finish(filePath, source, note) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large (${Math.round(stat.size / 1024)} KB, max ${MAX_IMAGE_BYTES / 1024 / 1024} MB): ${filePath}`);
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) throw new Error(`Not a supported image type (${ext || 'no extension'}): ${filePath}`);
  resolvedPaths.add(filePath);
  return { path: filePath, name: path.basename(filePath), mime, bytes: stat.size, source, note: note || null };
}

// Windows only. Takes a bitmap (Win+Shift+S, PrintScreen, "Copy image") or, failing
// that, an image file copied in Explorer. -STA is required by the clipboard API.
function readClipboardImage() {
  if (process.platform !== 'win32') {
    throw new Error('Reading an image from the clipboard is only supported on Windows. Give a file path instead.');
  }
  const out = path.join(tempDir(), `clipboard-${Date.now()}.png`);
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    `if ($img -ne $null) { $img.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'IMAGE'; exit 0 }`,
    '$files = [System.Windows.Forms.Clipboard]::GetFileDropList()',
    'foreach ($f in $files) { if ($f -match "\\.(png|jpe?g|gif|webp|bmp)$") { Write-Output ("FILE " + $f); exit 0 } }',
    'Write-Output "NONE"',
  ].join('; ');
  const result = execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  }).trim();
  if (result === 'IMAGE') return finish(out, 'clipboard');
  if (result.startsWith('FILE ')) return finish(result.slice(5).trim(), 'clipboard-file');
  throw new Error('The clipboard has no image in it. Copy the image (or take a screenshot with Win+Shift+S) and try again, or give its file path.');
}

async function downloadImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = Object.keys(IMAGE_MIME).find((e) => IMAGE_MIME[e] === type);
    if (!ext) throw new Error(`not an image (content-type: ${type || 'unknown'})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new Error(`too large (${Math.round(buf.length / 1024)} KB)`);
    const base = path.basename(new URL(url).pathname).replace(/\.[^.]*$/, '') || 'image';
    const out = path.join(tempDir(), `${base.replace(/[^\w.-]/g, '_')}-${crypto.randomBytes(3).toString('hex')}${ext}`);
    fs.writeFileSync(out, buf);
    return finish(out, 'url');
  } catch (err) {
    throw new Error(`Could not download image from ${url}: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Git Bash style /c/Users/... -> C:\Users\... ; ~ -> home directory.
function normalizeRef(ref) {
  let p = ref;
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  if (process.platform === 'win32') {
    const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
    if (m) p = `${m[1].toUpperCase()}:\\${m[2]}`;
  }
  return path.normalize(p);
}

// Breadth-first, so a shallow match wins over a deeply nested one with the same name.
function searchProject(projectRoot, fileName) {
  const target = fileName.toLowerCase();
  const matches = [];
  const queue = [projectRoot];
  let seen = 0;
  while (queue.length && seen < SEARCH_MAX_ENTRIES) {
    const dir = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      seen++;
      if (e.isDirectory()) {
        if (!SEARCH_SKIP_DIRS.has(e.name)) queue.push(path.join(dir, e.name));
      } else if (e.name.toLowerCase() === target) {
        matches.push(path.join(dir, e.name));
      }
    }
  }
  return matches;
}

async function resolveImage(projectRoot, { ref }) {
  const raw = String(ref || '').trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!raw) throw new Error('RESOLVE_IMAGE needs a path, file name, URL, or [Image] for the clipboard.');

  if (CLIPBOARD_TOKEN_RE.test(raw)) return readClipboardImage();
  if (/^https?:\/\//i.test(raw)) return downloadImage(raw);

  const tried = [];
  const asGiven = normalizeRef(raw);
  const candidates = path.isAbsolute(asGiven) ? [asGiven] : [path.resolve(projectRoot, asGiven)];
  for (const c of candidates) {
    tried.push(c);
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return finish(c, 'path');
  }

  const fileName = path.basename(asGiven.replace(/\\/g, '/'));
  const found = searchProject(projectRoot, fileName);
  tried.push(`search for "${fileName}" under ${projectRoot}`);
  if (found.length) {
    const note = found.length > 1
      ? `${found.length} files named ${fileName}; using the shallowest. Others: ${found.slice(1, 4).join(', ')}`
      : `not at ${tried[0]}; found by searching the project`;
    return finish(found[0], 'project-search', note);
  }
  throw new Error(`Image not found: ${raw}. Tried: ${tried.join('; ')}.`);
}

function readImageChunk(projectRoot, { path: filePath, index }) {
  if (!resolvedPaths.has(filePath)) {
    throw new Error('READ_IMAGE_CHUNK only reads files returned by RESOLVE_IMAGE in this session.');
  }
  const i = Number(index) || 0;
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.max(0, Math.min(CHUNK_BYTES, size - i * CHUNK_BYTES)));
    if (buf.length) fs.readSync(fd, buf, 0, buf.length, i * CHUNK_BYTES);
    return { base64: buf.toString('base64'), index: i, chunks: Math.ceil(size / CHUNK_BYTES) };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { resolveImage, readImageChunk, CLIPBOARD_TOKEN_RE };
