/**
 * consolidation-pg.js — жалобы на нарушения («Консолидация»).
 *
 * Раньше жалобы лежали одним JSON-файлом на склад, и любое изменение
 * (новая жалоба, результат WMS-поиска) синхронно переписывало весь файл —
 * при «Проверить все» сайт подвисал у всех. Теперь строка на жалобу:
 * поля жалобы — в data (jsonb, тот же объект, что отдаётся странице),
 * изменение — UPDATE одной строки.
 *
 * Фото — файлами на диске сервера (UPLOADS_DIR в server.js), сжимаются
 * ещё в браузере; отдаёт их Caddy напрямую, не Node.
 */

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
pool.on('error', err => console.error('[consolidation-pg] pool error:', err.message));

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS consolidation_complaints (
      warehouse_id TEXT NOT NULL,
      id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      data JSONB NOT NULL,
      PRIMARY KEY (warehouse_id, id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS consolidation_complaints_created_idx ON consolidation_complaints (warehouse_id, created_at DESC)');
}

/** Жалобы склада, новые сверху; from/to — ISO-границы даты подачи (необязательные). */
async function list({ from, to } = {}) {
  const params = [currentWarehouse()];
  let where = 'warehouse_id = $1';
  if (from) { params.push(from); where += ` AND created_at >= $${params.length}`; }
  if (to) { params.push(to); where += ` AND created_at <= $${params.length}`; }
  const { rows } = await pool.query(`SELECT data FROM consolidation_complaints WHERE ${where} ORDER BY created_at DESC`, params);
  return rows.map(r => r.data);
}

async function getMany(ids) {
  if (!ids.length) return [];
  const { rows } = await pool.query(
    'SELECT data FROM consolidation_complaints WHERE warehouse_id = $1 AND id = ANY($2::text[]) ORDER BY created_at DESC',
    [currentWarehouse(), ids]
  );
  return rows.map(r => r.data);
}

async function get(id) {
  return (await getMany([id]))[0] || null;
}

async function insert(c) {
  await pool.query(
    'INSERT INTO consolidation_complaints (warehouse_id, id, created_at, data) VALUES ($1, $2, $3, $4)',
    [currentWarehouse(), c.id, c.createdAt, c]
  );
}

/** Слить поля в жалобу; возвращает обновлённую или null, если такой нет. */
async function patch(id, fields) {
  const { rows } = await pool.query(
    'UPDATE consolidation_complaints SET data = data || $3::jsonb WHERE warehouse_id = $1 AND id = $2 RETURNING data',
    [currentWarehouse(), id, JSON.stringify(fields)]
  );
  return rows[0]?.data || null;
}

/** Удалить жалобу; возвращает удалённую (чтобы стереть её фото) или null. */
async function remove(id) {
  const { rows } = await pool.query(
    'DELETE FROM consolidation_complaints WHERE warehouse_id = $1 AND id = $2 RETURNING data',
    [currentWarehouse(), id]
  );
  return rows[0]?.data || null;
}

module.exports = { init, list, getMany, get, insert, patch, remove };
