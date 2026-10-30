// Конфиг node (config.json: Telegram, серверный токен WMS для мониторинга) и
// «Обновлено: ЧЧ:ММ» в статистике — время последней реальной выгрузки из WMS,
// у каждого склада своё. Хранится в базе (state-pg.js), чтобы переживать
// перезапуск; в памяти — кэш, чтобы частый опрос статуса не ходил в базу.
// Периодический серверный опрос WMS убран (2026-10-31): данные забирает браузер.
const path = require('path');
const fs = require('fs');
const { dataDir, currentWarehouse } = require('./warehouse-context');
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

const lastRunBy = new Map(); // склад → Date | null

async function getLastRun() {
  const wh = currentWarehouse();
  if (!lastRunBy.has(wh)) {
    const v = await state.get('last-run', { legacyFile: path.join(dataDir(), 'last-run.json') });
    const d = v?.lastRun ? new Date(v.lastRun) : null;
    lastRunBy.set(wh, d && !isNaN(d) ? d : null);
  }
  return lastRunBy.get(wh);
}

async function setLastRun(date) {
  const lastRun = date || new Date();
  lastRunBy.set(currentWarehouse(), lastRun);
  try {
    await state.set('last-run', { lastRun: lastRun.toISOString() });
  } catch (err) {
    console.error('[scheduler] last-run не сохранён:', err.message); // не критично — останется в памяти
  }
}

module.exports = { loadConfig, ensureDataDir, getLastRun, setLastRun, CONFIG_PATH, DATA_DIR };
