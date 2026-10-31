// Конфиг node (config.json: Telegram, серверный токен WMS для мониторинга) и
// запись «Обновлено» — времени последней реальной выгрузки из WMS (app_state,
// ключ last-run; читает dotnet — GET /api/status).
const path = require('path');
const fs = require('fs');
const state = require('./state-pg');

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

async function setLastRun(date) {
  try {
    await state.set('last-run', { lastRun: (date || new Date()).toISOString() });
  } catch (err) {
    console.error('[scheduler] last-run не сохранён:', err.message); // не критично
  }
}

module.exports = { loadConfig, ensureDataDir, setLastRun, CONFIG_PATH, DATA_DIR };
