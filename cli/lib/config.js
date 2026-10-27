const fs = require('fs');
const path = require('path');
const { DEFAULT_CONFIG, DEFAULT_PERMISSIONS } = require('../../shared/protocol');

function ensureProjectConfig(configDir) {
  fs.mkdirSync(configDir, { recursive: true });

  const configPath = path.join(configDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  }

  const permissionsPath = path.join(configDir, 'permissions.json');
  if (!fs.existsSync(permissionsPath)) {
    fs.writeFileSync(permissionsPath, JSON.stringify(DEFAULT_PERMISSIONS, null, 2) + '\n');
  }

  const memoryPath = path.join(configDir, 'memory.md');
  if (!fs.existsSync(memoryPath)) {
    fs.writeFileSync(memoryPath, '# Project Memory\n\n(No entries yet.)\n');
  }

  const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const config = {
    ...DEFAULT_CONFIG,
    ...rawConfig,
    phased: { ...DEFAULT_CONFIG.phased, ...((rawConfig && rawConfig.phased) || {}) },
    filetrack: { ...DEFAULT_CONFIG.filetrack, ...((rawConfig && rawConfig.filetrack) || {}) },
    stealth: { ...DEFAULT_CONFIG.stealth, ...((rawConfig && rawConfig.stealth) || {}) },
  };
  const permissions = JSON.parse(fs.readFileSync(permissionsPath, 'utf8'));
  return { configDir, configPath, permissionsPath, memoryPath, config, permissions };
}

module.exports = { ensureProjectConfig };
