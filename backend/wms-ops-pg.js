/**
 * wms-ops-pg.js — досоздание схемы таблицы `wms_ops` при старте сервера.
 *
 * Саму таблицу создаёт dotnet (WarehouseSchema.cs, шаг 00), он же пишет в неё
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
const { currentWarehouse } = require('./warehouse-context');

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

// Таблицы статистики с исполнителями: во всех executor — «фамилия имя
// отчество» прямо из полей WMS (lastName/firstName/middleName).
const EXECUTOR_TABLES = ['wms_ops', 'wms_placement', 'wms_stock_moves', 'wms_receiving', 'wms_remains'];

/**
 * Все исполнители, встречавшиеся в статистике: executor_id -> ФИО из WMS.
 * Заменяет обход всех почасовых JSON в GET /api/empl/find-unregistered —
 * группировка выполняется в Postgres и не блокирует event loop Node.
 * Раньше читалась только wms_ops (комплектация) — кто работал лишь на
 * размещении/спуске/пополнении/приёмке/остатках, в поиск не попадал.
 */
async function listExecutors() {
  const { rows: existing } = await pool.query(
    'SELECT t FROM unnest($1::text[]) AS t WHERE to_regclass(t) IS NOT NULL', [EXECUTOR_TABLES]);
  if (!existing.length) return [];
  const union = existing
    .map(({ t }) => `SELECT executor_id, executor FROM ${t} WHERE executor_id <> '' AND executor <> '' AND warehouse_id = $1`)
    .join(' UNION ');
  const { rows } = await pool.query(`
    SELECT executor_id,
           (array_agg(executor ORDER BY length(executor) DESC, executor))[1] AS executor
      FROM (${union}) AS e
     GROUP BY executor_id
  `, [currentWarehouse()]);
  return rows;
}

/**
 * Кто комплектовал по датам смен (09:00 даты → 09:00 следующей) — штучный
 * отбор, раскладка КДК и паллетный отбор в КДК. Для сводного отчёта
 * консолидации (выход сотрудников компаний по дням).
 * → [{ date: 'YYYY-MM-DD', executorId, executor }]
 */
async function pickersByShiftDate(dateFrom, dateTo) {
  const { rows } = await pool.query(`
    SELECT d AS date, executor_id AS "executorId", max(executor) AS executor
      FROM (
        SELECT to_char(CASE WHEN hour >= 9 THEN date ELSE date - 1 END, 'YYYY-MM-DD') AS d, executor_id, executor
          FROM wms_ops
         WHERE warehouse_id = $1
           AND operation_type IN ('PICK_BY_LINE', 'PALLET_SELECTION_MOVE_TO_PICK_BY_LINE', 'PIECE_SELECTION_PICKING')
           AND date BETWEEN $2::date AND $3::date + 1
           AND (executor_id <> '' OR executor <> '')
      ) AS t
     WHERE d BETWEEN $2 AND $3
     GROUP BY d, executor_id
  `, [currentWarehouse(), dateFrom, dateTo]);
  return rows;
}

module.exports = { init, listExecutors, pickersByShiftDate };
