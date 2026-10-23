/**
 * product-weights.js — таблица весов товаров из Excel (PowerBI выгрузка).
 * Excel: backend/data/product-weights.xlsx, строка 3 (индекс 2) — заголовки, с строки 4 — данные.
 * Ключ: "Артикул товара" (например "УТ-10579150"), значение: вес в граммах.
 */

const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const EXCEL_PATH = path.join(DATA_DIR, 'product-weights.xlsx');
const LEGACY_EXCEL_PATH = path.join(__dirname, 'data.xlsx');
// Веса, дозапрошенные из WMS (stocks/overview → measurements.weight) для
// товаров, которых нет в Excel: { article: { grams, productId, name, fetchedAt } }.
// Отдельный файл — чтобы новая загрузка Excel их не стирала. В справочник
// попадают только артикулы, которых нет в Excel (Excel главнее).
const WMS_WEIGHTS_PATH = path.join(DATA_DIR, 'product-weights-wms.json');

let weightMap = null; // Map<article, grams>

// ─── Postgres-зеркало (Фаза 3) ───────────────────────────────────────────────
// buildSummaryFromItems перенесён в backend-dotnet и читает веса из таблицы
// product_weights НАПРЯМУЮ (без кэша, тот же принцип, что и остальные *-pg.js
// модули) — Node остаётся единственным местом, где парсится сам Excel
// (проще, чем тащить Excel-библиотеку в .NET), но при каждой загрузке/удалении
// файла зеркалирует содержимое в Postgres. Синхронизация — fire-and-forget
// (не блокирует upload-ответ и не требует переводить getWeightGrams/getMap,
// используемые синхронно в горячих циклах server.js, в async) — таблица
// весов меняется редко (ручная загрузка Excel админом), а не на каждый
// запрос, так что кратковременная рассинхронизация не критична (в отличие
// от кэша сотрудников в Фазе 2, который был источником данных на каждый
// HTTP-запрос).
const USE_PG = process.env.USE_PG === 'true';
let pgPool = null;
if (USE_PG) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    host: process.env.PG_HOST || 'postgres',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    database: process.env.PG_DB || 'zlp',
    user: process.env.PG_USER || 'zlp',
    password: process.env.PG_PASSWORD || '',
  });
  // Без обработчика обрыв простаивающего соединения (рестарт Postgres, сеть)
  // всплывает как необработанное 'error' и роняет весь процесс Node.
  pgPool.on('error', err => console.error('[pg] product-weights pool:', err.message));
}

async function initPg() {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS product_weights (
      article TEXT PRIMARY KEY,
      grams NUMERIC NOT NULL
    )
  `);
}

async function syncMapToPg(map) {
  if (!pgPool) return;
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE product_weights');
    for (const [article, grams] of map) {
      await client.query('INSERT INTO product_weights (article, grams) VALUES ($1, $2)', [article, grams]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[product-weights] Postgres sync failed:', err.message);
  } finally {
    client.release();
  }
}

// Дописать/обновить отдельные артикулы, не трогая остальные (веса из WMS).
async function upsertPg(entries) {
  if (!pgPool || !entries.length) return;
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    for (const [article, grams] of entries) {
      await client.query('INSERT INTO product_weights (article, grams) VALUES ($1, $2) ON CONFLICT (article) DO UPDATE SET grams = $2', [article, grams]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[product-weights] Postgres upsert failed:', err.message);
  } finally {
    client.release();
  }
}

function loadWmsWeights() {
  try {
    if (fs.existsSync(WMS_WEIGHTS_PATH)) return JSON.parse(fs.readFileSync(WMS_WEIGHTS_PATH, 'utf8')) || {};
  } catch (err) {
    console.warn('[product-weights] product-weights-wms.json:', err.message);
  }
  return {};
}

function ensureExcelDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function migrateLegacyExcel() {
  try {
    ensureExcelDir();
    if (!fs.existsSync(EXCEL_PATH) && fs.existsSync(LEGACY_EXCEL_PATH)) {
      fs.copyFileSync(LEGACY_EXCEL_PATH, EXCEL_PATH);
      console.log('[product-weights] Migrated data.xlsx to', EXCEL_PATH);
    }
  } catch (err) {
    console.warn('[product-weights] Legacy migration failed:', err.message);
  }
}

function parseExcelWeight(val) {
  if (!val && val !== 0) return 0;
  const s = String(val).replace(',', '.').replace(/\u00a0|\u202f/g, ' ').trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(кг|г|kg|g|л|l|мл|ml)?$/i);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const u = (m[2] || '').toLowerCase();
  if (!u || u === 'кг' || u === 'kg') return v * 1000;
  if (u === 'г' || u === 'g') return v;
  if (u === 'л' || u === 'l') return v * 1000;
  if (u === 'мл' || u === 'ml') return v;
  return 0;
}

function loadWeightMap() {
  migrateLegacyExcel();
  if (!fs.existsSync(EXCEL_PATH)) {
    console.warn('[product-weights] product-weights.xlsx not found at', EXCEL_PATH);
    return withWmsWeights(new Map());
  }
  const xlsx = require('xlsx');
  const wb = xlsx.readFile(EXCEL_PATH);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1 });

  // Строка с заголовками — ищем среди первых 5 строк
  let headerRow = -1;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    if (rows[i].includes('Артикул товара')) { headerRow = i; break; }
  }
  if (headerRow < 0) {
    console.warn('[product-weights] Header row not found in product-weights.xlsx');
    return new Map();
  }

  const headers = rows[headerRow];
  const artIdx = headers.indexOf('Артикул товара');
  const weightIdx = headers.indexOf('Вес товара');
  if (artIdx < 0 || weightIdx < 0) {
    console.warn('[product-weights] Required columns not found');
    return new Map();
  }

  const map = new Map();
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const art = String(r[artIdx] || '').trim();
    if (!art) continue;
    if (map.has(art)) continue; // первое вхождение — единица товара
    const grams = parseExcelWeight(r[weightIdx]);
    if (grams > 0) map.set(art, grams);
  }

  console.log(`[product-weights] Loaded ${map.size} articles from product-weights.xlsx`);
  return withWmsWeights(map);
}

// Дополнить карту из Excel весами из WMS — только отсутствующие артикулы.
function withWmsWeights(map) {
  let added = 0;
  for (const [article, rec] of Object.entries(loadWmsWeights())) {
    const grams = Number(rec && rec.grams) || 0;
    if (grams > 0 && !map.has(article)) { map.set(article, grams); added++; }
  }
  if (added) console.log(`[product-weights] +${added} articles from WMS (product-weights-wms.json)`);
  return map;
}

/** Сохранить веса из WMS: entries — [{ article, grams, productId, name }]. Возвращает число записанных. */
function addWmsWeights(entries) {
  const wms = loadWmsWeights();
  const now = new Date().toISOString();
  const toPg = [];
  const excel = getMap();
  let saved = 0;
  for (const e of entries || []) {
    const article = String((e && e.article) || '').trim();
    const grams = Number(e && e.grams) || 0;
    if (!article || grams <= 0) continue;
    wms[article] = { grams, productId: e.productId || null, name: e.name || '', fetchedAt: now };
    saved++;
    // в справочник — только если веса нет (вес из Excel главнее)
    if (!excel.has(article)) { excel.set(article, grams); toPg.push([article, grams]); }
  }
  ensureExcelDir();
  fs.writeFileSync(WMS_WEIGHTS_PATH, JSON.stringify(wms), 'utf8');
  upsertPg(toPg).catch(err => console.error('[product-weights] upsertPg:', err.message));
  return saved;
}

function wmsWeightsCount() {
  return Object.keys(loadWmsWeights()).length;
}

function getMap() {
  if (!weightMap) weightMap = loadWeightMap();
  return weightMap;
}

/** Вернуть вес в граммах по артикулу товара. 0 если не найдено. */
function getWeightGrams(article) {
  if (!article) return 0;
  return getMap().get(String(article).trim()) || 0;
}

/** Перезагрузить таблицу из файла (при замене Excel с ВГХ). */
function reload() {
  weightMap = null;
  const map = getMap();
  syncMapToPg(map).catch(err => console.error('[product-weights] syncMapToPg:', err.message));
  return map;
}

function saveExcelBuffer(buffer) {
  ensureExcelDir();
  fs.writeFileSync(EXCEL_PATH, buffer);
  return reload();
}

function deleteExcel() {
  if (fs.existsSync(EXCEL_PATH)) fs.unlinkSync(EXCEL_PATH);
  // без Excel в справочнике остаются только веса из WMS
  reload();
}

module.exports = { EXCEL_PATH, getWeightGrams, getMap, reload, saveExcelBuffer, deleteExcel, initPg, addWmsWeights, wmsWeightsCount };
