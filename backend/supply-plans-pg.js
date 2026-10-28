/**
 * supply-plans-pg.js — график поставок (план приёмки по дням).
 *
 * Источник — Excel из корпоративной почты («График поставок», несколько дат
 * в одной таблице) или накопительный отчёт делопроизводителей (по листу на
 * день, лист «статистика» пропускается). Колонки ищутся по названию: в
 * старых листах между ними бывают пустые/служебные столбцы.
 *
 * Таблица supply_plans (по складам): строка — заказ поставщику на дату.
 * Загрузка файла заменяет строки тех дат, что в нём есть. Факт приёмки —
 * из WMS в браузере (сверка по номеру заказа) и сохраняется сюда:
 * supply_plan_facts — по заказам (статус, факт, ворота; extra — принятые вне
 * графика), supply_day_facts — итоги факта по дням из листа «статистика»
 * накопительного отчёта (история до сверок на сайте). Из них — накопительный
 * отчёт и рейтинг поставщиков. Прогноз СЗ КДК — по истории: план кросс-дока
 * за день против фактических СЗ КДК (wms_ops).
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
pool.on('error', err => console.error('[pg] supply-plans pool:', err.message));

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS supply_plans (
      warehouse_id  TEXT NOT NULL,
      plan_date     DATE NOT NULL,
      order_number  TEXT NOT NULL,
      supplier      TEXT NOT NULL DEFAULT '',
      doc_type      TEXT NOT NULL DEFAULT '',
      storage_type  TEXT NOT NULL DEFAULT '',
      supply_type   TEXT NOT NULL DEFAULT '',
      sku           NUMERIC NOT NULL DEFAULT 0,
      pieces        NUMERIC NOT NULL DEFAULT 0,
      weight_kg     NUMERIC NOT NULL DEFAULT 0,
      uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (warehouse_id, plan_date, order_number)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS supply_plan_facts (
      warehouse_id    TEXT NOT NULL,
      plan_date       DATE NOT NULL,
      order_number    TEXT NOT NULL,
      extra           BOOLEAN NOT NULL DEFAULT false,
      supplier        TEXT NOT NULL DEFAULT '',
      supply_type     TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT '',
      wms_status      TEXT NOT NULL DEFAULT '',
      fact_sku        NUMERIC,
      fact_pieces     NUMERIC,
      fact_weight_kg  NUMERIC,
      completed_at    TIMESTAMPTZ,
      gate            TEXT NOT NULL DEFAULT '',
      checked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (warehouse_id, plan_date, order_number, extra)
    )
  `);
  // тип хранения задания WMS (у вне графика — temperatureMode: ORDINARY/MEDIUM_COLD/LOW_COLD)
  await pool.query("ALTER TABLE supply_plan_facts ADD COLUMN IF NOT EXISTS storage_type TEXT NOT NULL DEFAULT ''");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS supply_day_facts (
      warehouse_id    TEXT NOT NULL,
      plan_date       DATE NOT NULL,
      fact_count      NUMERIC,
      fact_pieces     NUMERIC,
      fact_weight_kg  NUMERIC,
      fact_sku        NUMERIC,
      PRIMARY KEY (warehouse_id, plan_date)
    )
  `);
}

// ─── Разбор файла ──────────────────────────────────────────────────────────────

// «1,408» / «1 786.02» / «7261.20» / «0,5» → число
function parseNum(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  let s = String(v).replace(/[\s  ]/g, '');
  if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

// «28-10-2026» / «28.10.2026» / Excel-дата → «2026-10-28»
function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    // серийный номер даты Excel (дни с 1899-12-30)
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const m = String(v).trim().match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})/);
  if (!m) return null;
  const y = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// «Холод» (старые листы) — это средний холод
function normStorage(v) {
  const s = String(v || '').trim();
  return /^холод$/i.test(s) ? 'Средний холод' : s;
}

// Лист «статистика» накопительного отчёта: ДН | Дата | поставок план, факт, % |
// штуки план, факт, % | вес … | SKU … — берём факт (столбцы 3, 6, 9, 12).
function parseDayFacts(ws, xlsx) {
  if (ws['!ref']) {
    const range = xlsx.utils.decode_range(ws['!ref']);
    range.e.c = Math.min(range.e.c, 14);
    range.e.r = Math.min(range.e.r, 5000);
    ws['!ref'] = xlsx.utils.encode_range(range);
  }
  const out = [];
  for (const r of xlsx.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null })) {
    const date = parseDate(r[1]);
    if (!date || date < '2020-01-01' || typeof r[3] !== 'number') continue;
    out.push({ date, count: r[3], pieces: parseNum(r[6]), weightKg: parseNum(r[9]), sku: parseNum(r[12]) });
  }
  return out;
}

/**
 * Excel (буфер) → { rows: [{ date, orderNumber, supplier, docType, storageType,
 * supplyType, sku, pieces, weightKg }], dayFacts: [{ date, count, pieces, weightKg, sku }] }
 */
function parseWorkbook(buffer) {
  const xlsx = require('xlsx');
  const wb = xlsx.read(buffer, { type: 'buffer' });
  const out = new Map(); // date|order → строка (повтор заказа в той же дате — берём последний)
  // дата строки невозможная (опечатка в годе, мусор в ячейке) — берём дату
  // из названия листа накопительного отчёта (лист = день, «28.10.2026»)

  const horizon = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const plausible = d => d && d >= '2020-01-01' && d <= horizon;
  let dayFacts = [];
  for (const name of wb.SheetNames) {
    if (/статист/i.test(name)) { dayFacts = parseDayFacts(wb.Sheets[name], xlsx); continue; }
    const ws = wb.Sheets[name];
    // часть листов «растянута» до миллиона пустых строк — читаем первые 5000
    // (в день столько заказов не бывает), иначе разбор шёл минутами
    if (ws['!ref']) {
      const range = xlsx.utils.decode_range(ws['!ref']);
      range.e.r = Math.min(range.e.r, 5000);
      range.e.c = Math.min(range.e.c, 40);
      ws['!ref'] = xlsx.utils.encode_range(range);
    }
    const sheetDate = parseDate(name);
    const rows = xlsx.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    const hr = rows.slice(0, 6).findIndex(r => Array.isArray(r) && r.some(c => String(c || '').trim() === 'Номер заказа'));
    if (hr < 0) continue;
    const h = rows[hr].map(c => String(c || '').trim());
    const col = n => h.indexOf(n);
    const c = {
      date: col('Дата'), order: col('Номер заказа'), supplier: col('Поставщик'), doc: col('Тип документооборота'),
      storage: col('Тип товара (тип хранения)'), supply: col('Тип поставки'),
      sku: col('Кол-во SKU'), pieces: col('Кол-во штук'), weight: col('Вес, кг'),
    };
    if (c.date < 0 || c.order < 0) continue;
    for (let i = hr + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const order = String(r[c.order] ?? '').trim();
      let date = parseDate(r[c.date]);
      if (!plausible(date) && plausible(sheetDate)) date = sheetDate;
      if (!order || !plausible(date)) continue;
      out.set(`${date}|${order}`, {
        date,
        orderNumber: order,
        supplier: c.supplier >= 0 ? String(r[c.supplier] ?? '').trim() : '',
        docType: c.doc >= 0 ? String(r[c.doc] ?? '').trim() : '',
        storageType: c.storage >= 0 ? normStorage(r[c.storage]) : '',
        supplyType: c.supply >= 0 ? String(r[c.supply] ?? '').trim() : '',
        sku: c.sku >= 0 ? parseNum(r[c.sku]) : 0,
        pieces: c.pieces >= 0 ? parseNum(r[c.pieces]) : 0,
        weightKg: c.weight >= 0 ? parseNum(r[c.weight]) : 0,
      });
    }
  }
  return { rows: [...out.values()], dayFacts };
}

// ─── Запись / чтение ───────────────────────────────────────────────────────────

/** Заменить строки дат, которые есть в файле. Возвращает { rows, dates, from, to }. */
async function saveRows(rows) {
  const wh = currentWarehouse();
  const dates = [...new Set(rows.map(r => r.date))].sort();
  if (!dates.length) return { rows: 0, dates: 0, from: null, to: null };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM supply_plans WHERE warehouse_id = $1 AND plan_date = ANY($2::date[])', [wh, dates]);
    for (let i = 0; i < rows.length; i += 2000) {
      const ch = rows.slice(i, i + 2000);
      await client.query(
        `INSERT INTO supply_plans (warehouse_id, plan_date, order_number, supplier, doc_type, storage_type, supply_type, sku, pieces, weight_kg)
         SELECT $1, * FROM unnest($2::date[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::numeric[])
         ON CONFLICT (warehouse_id, plan_date, order_number) DO NOTHING`,
        [wh, ch.map(r => r.date), ch.map(r => r.orderNumber), ch.map(r => r.supplier), ch.map(r => r.docType),
          ch.map(r => r.storageType), ch.map(r => r.supplyType), ch.map(r => r.sku), ch.map(r => r.pieces), ch.map(r => r.weightKg)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { rows: rows.length, dates: dates.length, from: dates[0], to: dates[dates.length - 1] };
}

async function getDay(date) {
  const { rows } = await pool.query(
    `SELECT to_char(plan_date, 'YYYY-MM-DD') AS date, order_number AS "orderNumber", supplier, doc_type AS "docType",
            storage_type AS "storageType", supply_type AS "supplyType", sku::float AS sku, pieces::float AS pieces, weight_kg::float AS "weightKg"
       FROM supply_plans WHERE warehouse_id = $1 AND plan_date = $2::date ORDER BY supplier, order_number`,
    [currentWarehouse(), date]
  );
  return rows;
}

/** Даты с графиком: последние 60 дней и всё будущее — для выбора даты. */
async function listDates() {
  const { rows } = await pool.query(
    `SELECT to_char(plan_date, 'YYYY-MM-DD') AS date, count(*)::int AS orders
       FROM supply_plans WHERE warehouse_id = $1 AND plan_date >= current_date - 60
      GROUP BY plan_date ORDER BY plan_date`,
    [currentWarehouse()]
  );
  const { rows: total } = await pool.query('SELECT count(DISTINCT plan_date)::int AS days, min(plan_date) AS first FROM supply_plans WHERE warehouse_id = $1', [currentWarehouse()]);
  return { dates: rows, totalDays: total[0].days, firstDate: total[0].first };
}

/**
 * История для прогноза СЗ КДК: по дням — план кросс-дока (поставки, SKU,
 * штуки) и фактические СЗ КДК из wms_ops (раскладка PICK_BY_LINE: СЗ —
 * сотрудник + ячейка + товар, как в статистике). СЗ — по дате смены
 * (09:00 даты → 09:00 следующего дня), чтобы ночная работа шла в свой день.
 */
async function kdkHistory(days) {
  const wh = currentWarehouse();
  const { rows: plans } = await pool.query(
    `SELECT to_char(plan_date, 'YYYY-MM-DD') AS date, count(*)::int AS deliveries, sum(sku)::float AS sku, sum(pieces)::float AS pieces
       FROM supply_plans
      WHERE warehouse_id = $1 AND supply_type ILIKE 'кросс%' AND plan_date >= current_date - $2::int
      GROUP BY plan_date`,
    [wh, days]
  );
  let picks = [];
  try {
    const res = await pool.query(
      `SELECT to_char(CASE WHEN hour >= 9 THEN date ELSE date - 1 END, 'YYYY-MM-DD') AS date,
              count(DISTINCT (executor_id, cell, nomenclature_code))::int AS tasks
         FROM wms_ops
        WHERE warehouse_id = $1 AND operation_type = 'PICK_BY_LINE' AND date >= current_date - $2::int - 1
        GROUP BY 1`,
      [wh, days]
    );
    picks = res.rows;
  } catch (err) {
    console.error('[supply-plans] kdkHistory wms_ops:', err.message);
  }
  return { plans, picks };
}

/** Итоги факта по дням из «статистики» — заменяют прежние для этих дат. */
async function saveDayFacts(dayFacts) {
  if (!dayFacts.length) return 0;
  const wh = currentWarehouse();
  await pool.query(
    `INSERT INTO supply_day_facts (warehouse_id, plan_date, fact_count, fact_pieces, fact_weight_kg, fact_sku)
     SELECT $1, * FROM unnest($2::date[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[])
     ON CONFLICT (warehouse_id, plan_date) DO UPDATE SET fact_count = EXCLUDED.fact_count, fact_pieces = EXCLUDED.fact_pieces,
       fact_weight_kg = EXCLUDED.fact_weight_kg, fact_sku = EXCLUDED.fact_sku`,
    [wh, dayFacts.map(d => d.date), dayFacts.map(d => d.count), dayFacts.map(d => d.pieces), dayFacts.map(d => d.weightKg), dayFacts.map(d => d.sku)]
  );
  return dayFacts.length;
}

/** Результат сверки с WMS за дату — заменяет прежний. rows: заказы графика и вне графика (extra). */
async function saveFacts(date, rows) {
  const wh = currentWarehouse();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM supply_plan_facts WHERE warehouse_id = $1 AND plan_date = $2::date', [wh, date]);
    if (rows.length) {
      const col = k => rows.map(r => (r[k] == null ? null : r[k]));
      await client.query(
        `INSERT INTO supply_plan_facts (warehouse_id, plan_date, order_number, extra, supplier, supply_type, status, wms_status, fact_sku, fact_pieces, fact_weight_kg, completed_at, gate, storage_type)
         SELECT $1, $2::date, * FROM unnest($3::text[], $4::boolean[], $5::text[], $6::text[], $7::text[], $8::text[], $9::numeric[], $10::numeric[], $11::numeric[], $12::timestamptz[], $13::text[], $14::text[])
         ON CONFLICT DO NOTHING`,
        [wh, date, col('orderNumber'), rows.map(r => !!r.extra), rows.map(r => r.supplier || ''), rows.map(r => r.supplyType || ''),
          rows.map(r => r.status || ''), rows.map(r => r.wmsStatus || ''), col('factSku'), col('factPieces'), col('factWeightKg'), col('completedAt'), rows.map(r => r.gate || ''), rows.map(r => r.storageType || '')]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return rows.length;
}

/** Всё за период: план, факт по заказам, итоги факта по дням — для отчёта и рейтинга. */
async function getRange(from, to) {
  const wh = currentWarehouse();
  const [plans, facts, dayFacts] = await Promise.all([
    pool.query(
      `SELECT to_char(plan_date, 'YYYY-MM-DD') AS date, order_number AS "orderNumber", supplier, doc_type AS "docType",
              storage_type AS "storageType", supply_type AS "supplyType", sku::float AS sku, pieces::float AS pieces, weight_kg::float AS "weightKg"
         FROM supply_plans WHERE warehouse_id = $1 AND plan_date BETWEEN $2::date AND $3::date ORDER BY plan_date, supplier`, [wh, from, to]),
    pool.query(
      `SELECT to_char(plan_date, 'YYYY-MM-DD') AS date, order_number AS "orderNumber", extra, supplier, supply_type AS "supplyType",
              status, wms_status AS "wmsStatus", fact_sku::float AS "factSku", fact_pieces::float AS "factPieces", fact_weight_kg::float AS "factWeightKg",
              completed_at AS "completedAt", gate, storage_type AS "storageType", checked_at AS "checkedAt"
         FROM supply_plan_facts WHERE warehouse_id = $1 AND plan_date BETWEEN $2::date AND $3::date`, [wh, from, to]),
    pool.query(
      `SELECT to_char(plan_date, 'YYYY-MM-DD') AS date, fact_count::float AS count, fact_pieces::float AS pieces, fact_weight_kg::float AS "weightKg", fact_sku::float AS sku
         FROM supply_day_facts WHERE warehouse_id = $1 AND plan_date BETWEEN $2::date AND $3::date`, [wh, from, to]),
  ]);
  return { plans: plans.rows, facts: facts.rows, dayFacts: dayFacts.rows };
}

module.exports = { init, parseWorkbook, saveRows, saveDayFacts, saveFacts, getRange, getDay, listDates, kdkHistory };
