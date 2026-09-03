#!/usr/bin/env node
// Registers the native messaging host manifest with Chrome for the current OS.
// Usage: node native-host/install.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOST_NAME = 'com.myclaudecode.host';
const EXTENSION_ID_PATH = path.join(__dirname, 'dev-key', 'extension-id.txt');
const MANIFEST_OUT_PATH = path.join(__dirname, `${HOST_NAME}.json`);

function readExtensionId() {
  if (!fs.existsSync(EXTENSION_ID_PATH)) {
    console.error('No extension ID found. Run `node native-host/keygen.js` first.');
    process.exit(1);
  }
  return fs.readFileSync(EXTENSION_ID_PATH, 'utf8').trim();
}

function hostExecutablePath() {
  if (process.platform === 'win32') {
    return path.join(__dirname, 'host.bat');
  }
  return path.join(__dirname, 'host.js');
}

function writeManifest(extensionId) {
  const manifest = {
    name: HOST_NAME,
    description: 'MyClaudeCode native messaging host',
    path: hostExecutablePath(),
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  fs.writeFileSync(MANIFEST_OUT_PATH, JSON.stringify(manifest, null, 2) + '\n');
  return MANIFEST_OUT_PATH;
}

function ensureUnixExecutable(p) {
  try {
    fs.chmodSync(p, 0o755);
  } catch (_) {
    // best-effort
  }
}

function installLinux(manifestPath) {
  const dir = path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${HOST_NAME}.json`);
  fs.copyFileSync(manifestPath, dest);
  console.log(`Wrote manifest to ${dest}`);
}

function installMac(manifestPath) {
  const dir = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Google',
    'Chrome',
    'NativeMessagingHosts'
  );
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${HOST_NAME}.json`);
  fs.copyFileSync(manifestPath, dest);
  console.log(`Wrote manifest to ${dest}`);
}

function installWindows(manifestPath) {
  const regPath = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
  execFileSync('reg', ['add', regPath, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
    stdio: 'inherit',
  });
  console.log(`Registered ${regPath} -> ${manifestPath}`);
}

function main() {
  const extensionId = readExtensionId();
  const manifestPath = writeManifest(extensionId);
  console.log(`Native messaging manifest written to ${manifestPath}`);

  if (process.platform !== 'win32') {
    ensureUnixExecutable(hostExecutablePath());
  }

  switch (process.platform) {
    case 'linux':
      installLinux(manifestPath);
      break;
    case 'darwin':
      installMac(manifestPath);
      break;
    case 'win32':
      installWindows(manifestPath);
      break;
    default:
      console.error(`Unsupported platform: ${process.platform}`);
      process.exit(1);
  }

  console.log('\nDone. Restart Chrome, then load extension/ as an unpacked extension.');
  console.log(`Registered extension ID: ${extensionId}`);
}

main();
