// Конфиг node (config.json: Telegram, серверный токен WMS для мониторинга).
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(__dirname, 'data');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { token: '' };
  }
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

module.exports = { loadConfig, ensureDataDir, CONFIG_PATH, DATA_DIR };
