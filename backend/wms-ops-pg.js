/**
 * wms-ops-pg.js — досоздание схемы таблицы `wms_ops` при старте сервера.
 *
 * Саму таблицу создаёт разовый migrate-storage-json-to-pg.js, а пишет в неё
 * backend-dotnet (EF, /api/stats/ops/ingest) — по договорённости Фазы 3 .NET
 * схемой не владеет и миграций не делает (см. комментарий в AppDbContext.cs).
 * Поэтому новые колонки добавляются здесь, тем же приёмом, что в empl-pg.js
 * и tsd-pg.js: идемпотентный ALTER на старте.
 *
 * Полный DDL таблицы сознательно НЕ дублируем — иначе он разъедется с
 * миграцией; `ALTER TABLE IF EXISTS` тихо ничего не делает, если таблицы
 * ещё нет (установка без выполненной миграции).
 */

const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.PG_HOST     || 'postgres',
  port:     parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DB       || 'zlp',
  user:     process.env.PG_USER     || 'zlp',
  password: process.env.PG_PASSWORD || '',
});
// Без обработчика обрыв простаивающего соединения (рестарт Postgres, сеть)
// всплывает как необработанное 'error' и роняет весь процесс Node.
pool.on('error', err => console.error('[pg] wms-ops pool:', err.message));

async function init() {
  // GUID товара из ответа WMS (product.productId). NOT NULL DEFAULT '' —
  // чтобы у старых строк не осталось NULL: EF читает эту колонку в
  // невыводимую в null строку (WmsOpEntity.ProductId), и NULL уронил бы
  // чтение статистики за прошлые дни.
  await pool.query("ALTER TABLE IF EXISTS wms_ops ADD COLUMN IF NOT EXISTS product_id TEXT NOT NULL DEFAULT ''");
}

/**
 * Индексы (date, hour) для четырёх таблиц статистики (2026-09-13). Почти все
 * запросы dotnet фильтруют по дате И часу (StatsService: смена = date + hour,
 * дедупликация при ingest — date == и hour ==), а у wms_placement/receiving/
 * remains индексов не было вовсе — полный скан таблицы на каждый запрос.
 *
 * Вызывается в фоне ПОСЛЕ старта сервера, не из init(): первое построение на
 * миллионах строк идёт десятки секунд, и если бы старт его ждал, healthcheck
 * успел бы пометить node как unhealthy, а caddy (depends_on: service_healthy)
 * не поднялся бы. На время построения запись в таблицу ждёт, чтение идёт;
 * при следующих стартах IF NOT EXISTS отрабатывает мгновенно.
 */
const STATS_TABLES = ['wms_ops', 'wms_placement', 'wms_receiving', 'wms_remains'];

async function ensureStatsIndexes() {
  for (const table of STATS_TABLES) {
    try {
      const { rows } = await pool.query('SELECT to_regclass($1) AS t', [table]);
      if (!rows[0].t) continue; // таблицы ещё нет (миграция не выполнялась)
      const t0 = Date.now();
      await pool.query(`CREATE INDEX IF NOT EXISTS ${table}_date_hour_idx ON ${table} (date, hour)`);
      const sec = Math.round((Date.now() - t0) / 1000);
      if (sec >= 1) console.log(`[pg] индекс ${table}_date_hour_idx построен за ${sec} с`);
    } catch (err) {
      console.error(`[pg] индекс ${table}_date_hour_idx:`, err.message);
    }
  }
}

/**
 * Все исполнители, встречавшиеся в операциях: executor_id -> самое полное ФИО.
 * Заменяет обход всех почасовых JSON в GET /api/empl/find-unregistered —
 * группировка выполняется в Postgres и не блокирует event loop Node.
 */
async function listExecutors() {
  const { rows } = await pool.query(`
    SELECT executor_id,
           (array_agg(executor ORDER BY length(executor) DESC, executor))[1] AS executor
      FROM wms_ops
     WHERE executor_id <> '' AND executor <> ''
     GROUP BY executor_id
  `);
  return rows;
}

module.exports = { init, ensureStatsIndexes, listExecutors };
