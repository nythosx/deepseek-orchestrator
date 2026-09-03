#!/usr/bin/env node
// Generates a stable Chrome extension keypair + ID, the same way `chrome`
// does when it computes an unpacked extension's ID from a "key" field.
// Run once: `node native-host/keygen.js`. Re-running reuses the existing key.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_DIR = path.join(__dirname, 'dev-key');
const PRIVATE_KEY_PATH = path.join(KEY_DIR, 'private-key.pem');
const PUBLIC_KEY_B64_PATH = path.join(KEY_DIR, 'public-key.b64');
const EXTENSION_ID_PATH = path.join(KEY_DIR, 'extension-id.txt');

function computeExtensionId(publicKeyDer) {
  const hash = crypto.createHash('sha256').update(publicKeyDer).digest('hex');
  const first32 = hash.slice(0, 32);
  return first32.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

function main() {
  fs.mkdirSync(KEY_DIR, { recursive: true });

  let privateKeyPem;
  if (fs.existsSync(PRIVATE_KEY_PATH)) {
    privateKeyPem = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
  } else {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKeyPem = privateKey;
    fs.writeFileSync(PRIVATE_KEY_PATH, privateKeyPem);
    console.log(`Generated new dev signing key at ${PRIVATE_KEY_PATH}`);
  }

  const keyObject = crypto.createPrivateKey(privateKeyPem);
  const publicKeyDer = crypto.createPublicKey(keyObject).export({ type: 'spki', format: 'der' });
  const publicKeyB64 = publicKeyDer.toString('base64');
  const extensionId = computeExtensionId(publicKeyDer);

  fs.writeFileSync(PUBLIC_KEY_B64_PATH, publicKeyB64);
  fs.writeFileSync(EXTENSION_ID_PATH, extensionId);

  console.log(`Extension ID: ${extensionId}`);
  console.log(`Public key (base64) written to ${PUBLIC_KEY_B64_PATH}`);
  console.log('Run `node native-host/install.js` next to register the native messaging host.');
  console.log('The "key" field has already been written into extension/manifest.json.');

  // Keep extension/manifest.json's "key" field in sync automatically.
  const manifestPath = path.join(__dirname, '..', 'extension', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.key = publicKeyB64;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
}

main();
