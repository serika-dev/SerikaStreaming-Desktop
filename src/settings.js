const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  launchAtStartup: false,
  startMinimized: false,
  closeToTray: true,
  minimizeToTray: true,
  discordPresence: true,
  presencePort: 6464,
  hardwareAcceleration: true,
  zoomFactor: 1,
};

let cache = null;

function getConfigPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf8');
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(settings) {
  cache = { ...DEFAULTS, ...settings };
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error('[settings] Failed to save:', e.message);
  }
  return cache;
}

function get(key) {
  return load()[key];
}

function set(key, value) {
  const current = load();
  current[key] = value;
  return save(current);
}

module.exports = { DEFAULTS, load, save, get, set, getConfigPath };
