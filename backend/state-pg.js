/**
 * state-pg.js — небольшие данные node в Postgres: «склад + ключ → JSON».
 * Перекличка, нарушения, настройки автообновления, время последнего
 * обновления — раньше это были JSON-файлы в папке данных склада, которые
 * переписывались целиком на каждое изменение.
 *
 * Перенос без ручных шагов: если записи ещё нет, get() один раз читает
 * старый JSON-файл (legacyFile) и сохраняет его содержимое в базу. Файл
 * остаётся на диске как есть — удалить можно вручную, когда всё проверено.
 */

const fs = require('fs');
const { Pool } = require('pg');
const { currentWarehouse } = require('./warehouse-context');

const pool = new Pool({
  host:     process.env.PG_HOST     || 'postgres',
  port:     parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DB       || 'zlp',
  user:     process.env.PG_USER     || 'zlp',
  password: process.env.PG_PASSWORD || '',
});
// Без обработчика обрыв простаивающего соединения роняет весь процесс Node.
pool.on('error', err => console.error('[state-pg] pool error:', err.message));

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      warehouse_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (warehouse_id, key)
    )
  `);
}

async function set(key, value) {
  await pool.query(
    `INSERT INTO app_state (warehouse_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (warehouse_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [currentWarehouse(), key, JSON.stringify(value)]
  );
  return value;
}

/** Значение ключа склада; нет записи — из старого файла (и сохранить), иначе fallback. */
async function get(key, { legacyFile = null, fallback = null } = {}) {
  const { rows } = await pool.query('SELECT value FROM app_state WHERE warehouse_id = $1 AND key = $2', [currentWarehouse(), key]);
  if (rows.length) return rows[0].value;
  if (legacyFile && fs.existsSync(legacyFile)) {
    try {
      const value = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
      await set(key, value);
      console.log(`[state-pg] ${currentWarehouse()}/${key}: перенесено из ${legacyFile}`);
      return value;
    } catch (err) {
      console.error(`[state-pg] ${key}: не удалось прочитать ${legacyFile}:`, err.message);
    }
  }
  return fallback;
}

module.exports = { init, get, set };
