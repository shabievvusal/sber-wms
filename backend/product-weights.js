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
// Штрихкоды товара из того же Excel: «ШК товара» (у артикула несколько
// строк — по строке на каждый штрихкод) и «ШК упаковки N» со «Вложенностью
// упаковки N» — скан коробки засчитывается как её содержимое. Нужны «Поиску
// потеряшек» — в WMS у товара бывают не все штрихкоды.
let barcodeMap = null; // Map<barcode, { article, qty }> — qty: 1 у штучного, вложенность у упаковки

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
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS product_barcodes (
      barcode TEXT PRIMARY KEY,
      article TEXT NOT NULL
    )
  `);
  // qty — штук за один скан: 1 у штучного, вложенность у упаковки (2026-10-26)
  const { rows: qtyCol } = await pgPool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'product_barcodes' AND column_name = 'qty'");
  if (!qtyCol.length) await pgPool.query('ALTER TABLE product_barcodes ADD COLUMN qty NUMERIC NOT NULL DEFAULT 1');
  // штрихкоды появились позже весов (а упаковки — ещё позже): если таблица
  // пуста или без упаковок, а Excel уже загружен — заполняем, не дожидаясь
  // новой загрузки файла
  const { rows } = await pgPool.query('SELECT count(*)::int AS n, count(*) FILTER (WHERE qty > 1)::int AS packs FROM product_barcodes');
  const map = getBarcodeMap();
  const mapPacks = [...map.values()].filter(v => v.qty > 1).length;
  if (map.size && (!rows[0].n || (!qtyCol.length && mapPacks) || (mapPacks && !rows[0].packs))) await syncBarcodesToPg(map);
}

async function syncBarcodesToPg(map) {
  if (!pgPool) return;
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE product_barcodes');
    const entries = [...map];
    for (let i = 0; i < entries.length; i += 1000) {
      const chunk = entries.slice(i, i + 1000);
      await client.query(
        'INSERT INTO product_barcodes (barcode, article, qty) SELECT * FROM unnest($1::text[], $2::text[], $3::numeric[]) ON CONFLICT (barcode) DO NOTHING',
        [chunk.map(e => e[0]), chunk.map(e => e[1].article), chunk.map(e => e[1].qty)]
      );
    }
    await client.query('COMMIT');
    console.log(`[product-weights] product_barcodes: ${entries.length}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[product-weights] Postgres barcodes sync failed:', err.message);
  } finally {
    client.release();
  }
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
    barcodeMap = new Map();
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
  const col = name => headers.findIndex(h => String(h || '').trim() === name);
  const barcodeIdx = col('ШК товара');
  // упаковки 1..4: штрихкод и вложенность (сколько штук в упаковке)
  const packCols = [1, 2, 3, 4]
    .map(n => ({ bc: col(`ШК упаковки ${n}`), nest: col(`Вложенность упаковки ${n}`) }))
    .filter(p => p.bc >= 0 && p.nest >= 0);
  const splitCodes = v => String(v ?? '').split(/[,;\s]+/).map(c => c.trim()).filter(Boolean);
  barcodeMap = new Map();
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const art = String(r[artIdx] || '').trim();
    if (!art) continue;
    // в ячейке может быть несколько штрихкодов через запятую. Штучный
    // штрихкод главнее упаковочного: у части товаров в «ШК упаковки» стоят
    // их же штучные штрихкоды — иначе скан одной штуки шёл бы за коробку.
    if (barcodeIdx >= 0) {
      for (const code of splitCodes(r[barcodeIdx])) {
        const cur = barcodeMap.get(code);
        if (!cur || cur.qty > 1) barcodeMap.set(code, { article: art, qty: 1 });
      }
    }
    for (const p of packCols) {
      const nest = Number(String(r[p.nest] ?? '').replace(',', '.')) || 0;
      if (nest <= 1) continue;
      for (const code of splitCodes(r[p.bc])) {
        if (!barcodeMap.has(code)) barcodeMap.set(code, { article: art, qty: nest });
      }
    }
    if (map.has(art)) continue; // вес — из первой строки артикула (у остальных тот же)
    const grams = parseExcelWeight(r[weightIdx]);
    if (grams > 0) map.set(art, grams);
  }

  console.log(`[product-weights] Loaded ${map.size} articles, ${barcodeMap.size} barcodes from product-weights.xlsx`);
  return withWmsWeights(map);
}

// Дополнить карту из Excel весами из WMS — только отсутствующие артикулы.
function withWmsWeights(map) {
  let added = 0;
  const wms = loadWmsWeights();
  for (const [article, rec] of Object.entries(wms)) {
    const grams = Number(rec && rec.grams) || 0;
    if (grams > 0 && !map.has(article)) { map.set(article, grams); added++; }
  }
  if (added) console.log(`[product-weights] +${added} articles from WMS (product-weights-wms.json)`);
  mergeWmsBarcodes(wms);
  return map;
}

// Штрихкоды из карточки товара WMS (сохранены при дозапросе веса): штучные —
// 1 шт., упаковки — quantityInPackage. Штучный главнее упаковочного, как и
// для Excel; уже известный штрихкод не перезаписываем.
function mergeWmsBarcodes(wms) {
  if (!barcodeMap) barcodeMap = new Map();
  for (const [article, rec] of Object.entries(wms || {})) {
    for (const code of (rec && rec.barcodes) || []) {
      const cur = barcodeMap.get(code);
      if (!cur || cur.qty > 1) barcodeMap.set(code, { article, qty: 1 });
    }
    for (const pk of (rec && rec.packages) || []) {
      const qty = Number(pk && pk.qty) || 0;
      if (pk && pk.barcode && qty > 1 && !barcodeMap.has(pk.barcode)) barcodeMap.set(pk.barcode, { article, qty });
    }
  }
}

/**
 * Сохранить данные карточки товара из WMS: entries — [{ article, grams,
 * productId, name, barcodes, packages: [{ barcode, qty }] }]. Запись — если
 * есть вес или штрихкоды. Возвращает число записанных.
 */
function addWmsWeights(entries) {
  const wms = loadWmsWeights();
  const now = new Date().toISOString();
  const toPg = [];
  const excel = getMap();
  let saved = 0;
  let barcodesChanged = false;
  for (const e of entries || []) {
    const article = String((e && e.article) || '').trim();
    const grams = Number(e && e.grams) || 0;
    const barcodes = Array.isArray(e && e.barcodes) ? e.barcodes.map(String).filter(Boolean) : [];
    const packages = Array.isArray(e && e.packages)
      ? e.packages.map(pk => ({ barcode: String((pk && pk.barcode) || ''), qty: Number(pk && pk.qty) || 0 })).filter(pk => pk.barcode && pk.qty > 1)
      : [];
    if (!article || (grams <= 0 && !barcodes.length && !packages.length)) continue;
    const prev = wms[article] || {};
    wms[article] = { grams: grams > 0 ? grams : (prev.grams || 0), productId: e.productId || prev.productId || null, name: e.name || prev.name || '', barcodes, packages, fetchedAt: now };
    saved++;
    if (barcodes.length || packages.length) barcodesChanged = true;
    // в справочник — только если веса нет (вес из Excel главнее)
    if (grams > 0 && !excel.has(article)) { excel.set(article, grams); toPg.push([article, grams]); }
  }
  ensureExcelDir();
  fs.writeFileSync(WMS_WEIGHTS_PATH, JSON.stringify(wms), 'utf8');
  upsertPg(toPg).catch(err => console.error('[product-weights] upsertPg:', err.message));
  if (barcodesChanged) {
    mergeWmsBarcodes(wms);
    syncBarcodesToPg(getBarcodeMap()).catch(err => console.error('[product-weights] syncBarcodesToPg:', err.message));
  }
  return saved;
}

function wmsWeightsCount() {
  return Object.keys(loadWmsWeights()).length;
}

function getBarcodeMap() {
  if (!barcodeMap) getMap();
  return barcodeMap || new Map();
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
  barcodeMap = null;
  const map = getMap();
  syncMapToPg(map).catch(err => console.error('[product-weights] syncMapToPg:', err.message));
  syncBarcodesToPg(getBarcodeMap()).catch(err => console.error('[product-weights] syncBarcodesToPg:', err.message));
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

module.exports = { EXCEL_PATH, getWeightGrams, getMap, getBarcodeMap, reload, saveExcelBuffer, deleteExcel, initPg, addWmsWeights, wmsWeightsCount };
