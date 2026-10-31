/**
 * route-rk-pg.js — то, что нужно node от маршрутов РК: адреса ЦФЗ и данные
 * отчёта отгрузки (коды магазинов). Сами маршруты РК — в dotnet (RouteService.cs).
 * init() создаёт таблицу routes — её же читает и пишет dotnet.
 * Настройки: PG_HOST, PG_PORT, PG_DB, PG_USER, PG_PASSWORD
 */

const pg   = require('pg');
const { currentWarehouse } = require('./warehouse-context');
const { Pool } = pg;
// Возвращаем DATE как строку "YYYY-MM-DD" вместо объекта Date
pg.types.setTypeParser(1082, val => val);

const pool = new Pool({
  host:     process.env.PG_HOST     || 'postgres',
  port:     parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DB       || 'zlp',
  user:     process.env.PG_USER     || 'zlp',
  password: process.env.PG_PASSWORD || '',
});
// Без обработчика обрыв простаивающего соединения (рестарт Postgres, сеть)
// всплывает как необработанное 'error' и роняет весь процесс Node.
pool.on('error', err => console.error('[pg] route-rk pool:', err.message));

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS routes (
      route_id          TEXT PRIMARY KEY,
      route_number      TEXT,
      date              DATE,
      driver            JSONB,
      vehicle           JSONB,
      logistics_company TEXT,
      cfz_addresses     JSONB NOT NULL DEFAULT '[]',
      imported_at       TIMESTAMPTZ,
      shipment          JSONB,
      receiving         JSONB
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS routes_date_idx ON routes (date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS routes_route_number_idx ON routes (route_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS routes_driver_name_idx ON routes ((driver->>'name'))`);
}

// ─── Row ↔ object ──────────────────────────────────────────────────────────────

function rowToRoute(row) {
  return {
    routeId:          row.route_id,
    routeNumber:      row.route_number,
    date:             row.date ? String(row.date).slice(0, 10) : null,
    driver:           row.driver,
    vehicle:          row.vehicle,
    logisticsCompany: row.logistics_company,
    cfzAddresses:     row.cfz_addresses || [],
    importedAt:       row.imported_at,
    shipment:         row.shipment,
    receiving:        row.receiving,
  };
}

// ─── Вычисляемые поля ───────────────────────

// ─── WMS импорт ───────────────────────────────────────────────────────────────

// ─── Отгрузка / Приёмка ───────────────────────────────────────────────────────

// ─── Запросы ──────────────────────────────────────────────────────────────────

async function getAddresses() {
  // маршруты склада запроса (отчёт по отгрузке, коды адресов)
  const { rows } = await pool.query('SELECT cfz_addresses FROM routes WHERE warehouse_id = $1', [currentWarehouse()]);
  const set = new Set();
  for (const row of rows) {
    for (const a of (row.cfz_addresses || [])) {
      if (a.address) set.add(a.address);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
}

async function getReportData(dateFrom, dateTo) {
  const { rows } = await pool.query('SELECT * FROM routes WHERE warehouse_id = $1', [currentWarehouse()]);
  const map = new Map();

  function ensureCell(addr, date) {
    if (!map.has(addr)) map.set(addr, new Map());
    const dm = map.get(addr);
    if (!dm.has(date)) dm.set(date, { shipped: 0, received: null, shippedBoxes: 0, receivedBoxes: null, shippedThermalCovers: 0, receivedThermalCovers: null });
    return dm.get(date);
  }

  for (const raw of rows) {
    const route = rowToRoute(raw);
    if (route.shipment) {
      const shipDate = (route.shipment.at || route.date || '').slice(0, 10);
      if (shipDate >= dateFrom && shipDate <= dateTo) {
        for (const item of (route.shipment.items || [])) {
          const cell = ensureCell(item.address, shipDate);
          cell.shipped += item.rk;
          if (item.boxes) cell.shippedBoxes += item.boxes;
          if (item.thermalCovers) cell.shippedThermalCovers += item.thermalCovers;
        }
      }
    }
    if (route.receiving) {
      const recvDate = (route.receiving.at || route.date || '').slice(0, 10);
      if (recvDate >= dateFrom && recvDate <= dateTo) {
        for (const item of (route.receiving.items || [])) {
          const cell = ensureCell(item.address, recvDate);
          cell.received = (cell.received || 0) + item.rk;
          if (item.boxes) cell.receivedBoxes = (cell.receivedBoxes || 0) + item.boxes;
          if (item.thermalCovers) cell.receivedThermalCovers = (cell.receivedThermalCovers || 0) + item.thermalCovers;
        }
      }
    }
  }

  return [...map.entries()]
    .map(([address, dm]) => ({
      address,
      records: [...dm.entries()]
        .filter(([, v]) => v.shipped > 0 || v.received != null || v.shippedBoxes > 0 || v.receivedBoxes != null || v.shippedThermalCovers > 0 || v.receivedThermalCovers != null)
        .map(([date, v]) => ({ date, shipped: v.shipped, received: v.received, shippedBoxes: v.shippedBoxes, receivedBoxes: v.receivedBoxes, shippedThermalCovers: v.shippedThermalCovers, receivedThermalCovers: v.receivedThermalCovers }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    }))
    .filter(e => e.records.length > 0)
    .sort((a, b) => String(a.address).localeCompare(String(b.address), 'ru'));
}

// ─── ЕО ───────────────────────────────────────────────────────────────────────

// ─── Фото ─────────────────────────────────────────────────────────────────────

// ─── Поиск маршрутов (для страницы кладовщика) ────────────────────────────────

module.exports = {
  init,
  getAddresses,
  getReportData,
};
