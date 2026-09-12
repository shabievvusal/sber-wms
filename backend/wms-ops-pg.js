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

async function init() {
  // GUID товара из ответа WMS (product.productId). NOT NULL DEFAULT '' —
  // чтобы у старых строк не осталось NULL: EF читает эту колонку в
  // невыводимую в null строку (WmsOpEntity.ProductId), и NULL уронил бы
  // чтение статистики за прошлые дни.
  await pool.query("ALTER TABLE IF EXISTS wms_ops ADD COLUMN IF NOT EXISTS product_id TEXT NOT NULL DEFAULT ''");
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

module.exports = { init, listExecutors };
