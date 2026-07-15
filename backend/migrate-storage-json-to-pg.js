/**
 * migrate-storage-json-to-pg.js — переносит storage.js (Фаза 3: статистика/
 * агрегации) из JSON-файлов в PostgreSQL: data/<date>/<HH>.json (ops),
 * data/<date>/{placement,receiving,remains}/<HH>.json, старые
 * data/shift_<key>.json (легаси-формат, полные объекты), и
 * data/product-weights.xlsx.
 *
 * Запуск:
 *   docker exec <node-container> node /app/backend/migrate-storage-json-to-pg.js
 *
 * Переменные окружения: PG_HOST, PG_PORT, PG_DB, PG_USER, PG_PASSWORD
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATA_DIR = path.join(__dirname, 'data');
const MOSCOW_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;

const pool = new Pool({
  host: process.env.PG_HOST || 'postgres',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DB || 'zlp',
  user: process.env.PG_USER || 'zlp',
  password: process.env.PG_PASSWORD || '',
});

// ─── Схема (идемпотентно, как и в migrate-json-to-pg.js) ───────────────────

async function createSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wms_ops (
      id BIGSERIAL PRIMARY KEY,
      date DATE NOT NULL, hour SMALLINT NOT NULL, merge_key TEXT NOT NULL,
      item_id TEXT, type TEXT, operation_type TEXT, product_name TEXT,
      nomenclature_code TEXT, barcodes TEXT, production_date TEXT,
      best_before_date TEXT, source_barcode TEXT, cell TEXT, target_barcode TEXT,
      started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
      executor TEXT, executor_id TEXT,
      src_old NUMERIC, src_new NUMERIC, tgt_old NUMERIC, tgt_new NUMERIC, quantity NUMERIC,
      UNIQUE (date, hour, merge_key)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS wms_ops_date_idx ON wms_ops (date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS wms_ops_executor_id_idx ON wms_ops (executor_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wms_placement (
      id BIGSERIAL PRIMARY KEY,
      date DATE NOT NULL, hour SMALLINT NOT NULL, merge_key TEXT NOT NULL,
      item_id TEXT, status TEXT, handling_unit_barcode TEXT,
      source_cell_address TEXT, target_cell_address TEXT,
      target_cells_addresses JSONB NOT NULL DEFAULT '[]',
      source_zone_id TEXT, source_zone_name TEXT,
      responsible_user JSONB NOT NULL DEFAULT '{}',
      executor_id TEXT, executor TEXT, created_at TIMESTAMPTZ,
      issue TEXT, condition TEXT, temperature_mode TEXT, sku_count NUMERIC,
      UNIQUE (date, hour, merge_key)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wms_receiving (
      id BIGSERIAL PRIMARY KEY,
      date DATE NOT NULL, hour SMALLINT NOT NULL, merge_key TEXT NOT NULL,
      item_id TEXT, status TEXT, type TEXT, task_number TEXT, order_number TEXT,
      supplier_name TEXT, started_at TIMESTAMPTZ,
      responsible_user JSONB NOT NULL DEFAULT '{}',
      executor_id TEXT, executor TEXT, completed_at TIMESTAMPTZ,
      volume_in_milliliters NUMERIC, weight_in_grams NUMERIC, eo_count NUMERIC,
      UNIQUE (date, hour, merge_key)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wms_remains (
      id BIGSERIAL PRIMARY KEY,
      date DATE NOT NULL, hour SMALLINT NOT NULL, merge_key TEXT NOT NULL,
      item_id TEXT, status TEXT, task_type TEXT,
      source_cell_address TEXT, source_handling_unit_barcode TEXT,
      target_cell_address TEXT, target_handling_unit_barcode TEXT,
      consolidation_items JSONB NOT NULL DEFAULT '[]',
      responsible_user JSONB NOT NULL DEFAULT '{}',
      executor_id TEXT, executor TEXT, created_at TIMESTAMPTZ,
      UNIQUE (date, hour, merge_key)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_weights (
      article TEXT PRIMARY KEY,
      grams NUMERIC NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wms_storage_agg (
      date DATE NOT NULL, shift TEXT NOT NULL,
      total_storage_count NUMERIC NOT NULL DEFAULT 0,
      storage_by_hour JSONB NOT NULL DEFAULT '{}',
      total_weight_grams NUMERIC NOT NULL DEFAULT 0,
      weight_by_employee JSONB NOT NULL DEFAULT '{}',
      PRIMARY KEY (date, shift)
    )
  `);
}

// ─── Хелперы (1-в-1 из storage.js, продублированы — как и в migrate-json-to-pg.js) ─

function getMoscowDateHour(ts) {
  const d = new Date(ts);
  const moscow = new Date(d.getTime() + MOSCOW_UTC_OFFSET_MS);
  return { dateStr: moscow.toISOString().slice(0, 10), hour: moscow.getUTCHours() };
}

function getMergeKeyFromLight(light) {
  const type = (light.operationType || light.type || '').toUpperCase();
  const isTaskType = type === 'PICK_BY_LINE' || type === 'PIECE_SELECTION_PICKING';
  if (isTaskType) {
    const exec = light.executor || '';
    const cell = light.cell || '';
    const product = light.nomenclatureCode || light.productName || '';
    return `task|${exec}|${cell}|${product}`;
  }
  return `id|${light.id || ''}`;
}

function getMergeKey(item) {
  const type = (item.operationType || item.type || '').toUpperCase();
  const isTaskType = type === 'PICK_BY_LINE' || type === 'PIECE_SELECTION_PICKING';
  if (isTaskType) {
    const exec = (item.responsibleUser && (item.responsibleUser.id || [item.responsibleUser.lastName, item.responsibleUser.firstName].filter(Boolean).join(' '))) || '';
    const cell = (item.targetAddress && item.targetAddress.cellAddress) || (item.sourceAddress && item.sourceAddress.cellAddress) || '';
    const product = (item.product && (item.product.nomenclatureCode || item.product.name)) || '';
    return `task|${exec}|${cell}|${product}`;
  }
  return `id|${item.id || ''}`;
}

function toLightItem(item) {
  const ru = item.responsibleUser || {};
  const executor = [ru.lastName, ru.firstName, ru.middleName].filter(p => p && p.trim() !== '-').join(' ').trim() || '';
  const product = item.product || {};
  return {
    id: item.id || '',
    type: item.type || '',
    operationType: item.operationType || '',
    productName: product.name || '',
    nomenclatureCode: product.nomenclatureCode || '',
    barcodes: (product.barcodes || []).join(', '),
    productionDate: item.part?.productionDate || '',
    bestBeforeDate: item.part?.bestBeforeDate || '',
    sourceBarcode: item.sourceAddress?.handlingUnitBarcode || '',
    cell: (item.targetAddress && item.targetAddress.cellAddress) || (item.sourceAddress && item.sourceAddress.cellAddress) || '',
    targetBarcode: item.targetAddress?.handlingUnitBarcode || '',
    startedAt: item.operationStartedAt || '',
    completedAt: item.operationCompletedAt || '',
    executor,
    executorId: ru.id || '',
    srcOld: item.sourceQuantity?.oldQuantity ?? '',
    srcNew: item.sourceQuantity?.newQuantity ?? '',
    tgtOld: item.targetQuantity?.oldQuantity ?? '',
    tgtNew: item.targetQuantity?.newQuantity ?? '',
    quantity: item.targetQuantity?.newQuantity ?? item.sourceQuantity?.oldQuantity ?? '',
  };
}

function num(v) {
  return v === '' || v === null || v === undefined ? null : Number(v);
}

function ts(v) {
  return v ? new Date(v) : null;
}

// ─── Батч-вставка с upsert (ON CONFLICT DO UPDATE), как в migrate-json-to-pg.js ─

async function insertBatch(client, table, columns, conflictCols, rows) {
  for (const row of rows) {
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(',');
    const updates = columns.filter(c => !conflictCols.includes(c)).map(c => `${c} = EXCLUDED.${c}`).join(', ');
    await client.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})
       ON CONFLICT (${conflictCols.join(',')}) DO UPDATE SET ${updates}`,
      columns.map(c => row[c])
    );
  }
}

let opsCount = 0, placementCount = 0, receivingCount = 0, remainsCount = 0, errors = 0;

async function migrateOpsFile(client, dateStr, hour, filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const list = Array.isArray(raw.items) ? raw.items : Object.values(raw.items || {});
  const rows = list.map(item => ({
    date: dateStr, hour, merge_key: getMergeKeyFromLight(item),
    item_id: item.id || '', type: item.type || '', operation_type: item.operationType || '',
    product_name: item.productName || '', nomenclature_code: item.nomenclatureCode || '',
    barcodes: item.barcodes || '', production_date: item.productionDate || '',
    best_before_date: item.bestBeforeDate || '', source_barcode: item.sourceBarcode || '',
    cell: item.cell || '', target_barcode: item.targetBarcode || '',
    started_at: ts(item.startedAt), completed_at: ts(item.completedAt),
    executor: item.executor || '', executor_id: item.executorId || '',
    src_old: num(item.srcOld), src_new: num(item.srcNew), tgt_old: num(item.tgtOld), tgt_new: num(item.tgtNew),
    quantity: num(item.quantity),
  }));
  await insertBatch(client, 'wms_ops',
    ['date', 'hour', 'merge_key', 'item_id', 'type', 'operation_type', 'product_name', 'nomenclature_code', 'barcodes', 'production_date', 'best_before_date', 'source_barcode', 'cell', 'target_barcode', 'started_at', 'completed_at', 'executor', 'executor_id', 'src_old', 'src_new', 'tgt_old', 'tgt_new', 'quantity'],
    ['date', 'hour', 'merge_key'], rows);
  opsCount += rows.length;
}

async function migrateLegacyShiftFile(client, filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const items = Object.values(raw.items || {});
  const byDateHour = new Map();
  for (const item of items) {
    const compAt = item.operationCompletedAt;
    if (!compAt) continue;
    const { dateStr, hour } = getMoscowDateHour(compAt);
    const key = `${dateStr}\t${hour}`;
    if (!byDateHour.has(key)) byDateHour.set(key, []);
    byDateHour.get(key).push(item);
  }
  for (const [key, list] of byDateHour) {
    const [dateStr, hourStr] = key.split('\t');
    const hour = parseInt(hourStr, 10);
    const rows = list.map(item => {
      const light = toLightItem(item);
      return {
        date: dateStr, hour, merge_key: getMergeKey(item),
        item_id: light.id, type: light.type, operation_type: light.operationType,
        product_name: light.productName, nomenclature_code: light.nomenclatureCode,
        barcodes: light.barcodes, production_date: light.productionDate,
        best_before_date: light.bestBeforeDate, source_barcode: light.sourceBarcode,
        cell: light.cell, target_barcode: light.targetBarcode,
        started_at: ts(light.startedAt), completed_at: ts(light.completedAt),
        executor: light.executor, executor_id: light.executorId,
        src_old: num(light.srcOld), src_new: num(light.srcNew), tgt_old: num(light.tgtOld), tgt_new: num(light.tgtNew),
        quantity: num(light.quantity),
      };
    });
    await insertBatch(client, 'wms_ops',
      ['date', 'hour', 'merge_key', 'item_id', 'type', 'operation_type', 'product_name', 'nomenclature_code', 'barcodes', 'production_date', 'best_before_date', 'source_barcode', 'cell', 'target_barcode', 'started_at', 'completed_at', 'executor', 'executor_id', 'src_old', 'src_new', 'tgt_old', 'tgt_new', 'quantity'],
      ['date', 'hour', 'merge_key'], rows);
    opsCount += rows.length;
  }
}

function mergeKeyPlacementLike(item, secondaryField) {
  return item.id || item[secondaryField] || `${item.createdAt || item.completedAt}|${item.executorId}|${item.targetCellAddress || item.taskNumber || ''}`;
}

async function migratePlacementFile(client, dateStr, hour, filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const list = Array.isArray(raw.items) ? raw.items : Object.values(raw.items || {});
  const rows = list.map(item => ({
    date: dateStr, hour, merge_key: mergeKeyPlacementLike(item, 'handlingUnitBarcode'),
    item_id: item.id || '', status: item.status || '', handling_unit_barcode: item.handlingUnitBarcode || '',
    source_cell_address: item.sourceCellAddress || '', target_cell_address: item.targetCellAddress || '',
    target_cells_addresses: JSON.stringify(item.targetCellsAddresses || []),
    source_zone_id: item.sourceZoneId || '', source_zone_name: item.sourceZoneName || '',
    responsible_user: JSON.stringify(item.responsibleUser || {}),
    executor_id: item.executorId || '', executor: item.executor || '', created_at: ts(item.createdAt),
    issue: item.issue || '', condition: item.condition || '', temperature_mode: item.temperatureMode || '',
    sku_count: num(item.skuCount) || 0,
  }));
  await insertBatch(client, 'wms_placement',
    ['date', 'hour', 'merge_key', 'item_id', 'status', 'handling_unit_barcode', 'source_cell_address', 'target_cell_address', 'target_cells_addresses', 'source_zone_id', 'source_zone_name', 'responsible_user', 'executor_id', 'executor', 'created_at', 'issue', 'condition', 'temperature_mode', 'sku_count'],
    ['date', 'hour', 'merge_key'], rows);
  placementCount += rows.length;
}

async function migrateReceivingFile(client, dateStr, hour, filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const list = Array.isArray(raw.items) ? raw.items : Object.values(raw.items || {});
  const rows = list.map(item => ({
    date: dateStr, hour, merge_key: item.id || `${item.completedAt}|${item.executorId}|${item.taskNumber}`,
    item_id: item.id || '', status: item.status || '', type: item.type || '',
    task_number: item.taskNumber || '', order_number: item.orderNumber || '', supplier_name: item.supplierName || '',
    started_at: ts(item.startedAt),
    responsible_user: JSON.stringify(item.responsibleUser || {}),
    executor_id: item.executorId || '', executor: item.executor || '', completed_at: ts(item.completedAt),
    volume_in_milliliters: num(item.volumeInMilliliters) || 0, weight_in_grams: num(item.weightInGrams) || 0,
    eo_count: num(item.eoCount) || 0,
  }));
  await insertBatch(client, 'wms_receiving',
    ['date', 'hour', 'merge_key', 'item_id', 'status', 'type', 'task_number', 'order_number', 'supplier_name', 'started_at', 'responsible_user', 'executor_id', 'executor', 'completed_at', 'volume_in_milliliters', 'weight_in_grams', 'eo_count'],
    ['date', 'hour', 'merge_key'], rows);
  receivingCount += rows.length;
}

async function migrateRemainsFile(client, dateStr, hour, filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const list = Array.isArray(raw.items) ? raw.items : Object.values(raw.items || {});
  const rows = list.map(item => ({
    date: dateStr, hour,
    merge_key: item.id || `${item.createdAt}|${item.executorId}|${item.sourceHandlingUnitBarcode}|${item.targetHandlingUnitBarcode}`,
    item_id: item.id || '', status: item.status || '', task_type: item.taskType || '',
    source_cell_address: item.sourceCellAddress || '', source_handling_unit_barcode: item.sourceHandlingUnitBarcode || '',
    target_cell_address: item.targetCellAddress || '', target_handling_unit_barcode: item.targetHandlingUnitBarcode || '',
    consolidation_items: JSON.stringify(item.consolidationItems || []),
    responsible_user: JSON.stringify(item.responsibleUser || {}),
    executor_id: item.executorId || '', executor: item.executor || '', created_at: ts(item.createdAt),
  }));
  await insertBatch(client, 'wms_remains',
    ['date', 'hour', 'merge_key', 'item_id', 'status', 'task_type', 'source_cell_address', 'source_handling_unit_barcode', 'target_cell_address', 'target_handling_unit_barcode', 'consolidation_items', 'responsible_user', 'executor_id', 'executor', 'created_at'],
    ['date', 'hour', 'merge_key'], rows);
  remainsCount += rows.length;
}

async function migrateProductWeights(client) {
  const excelPath = path.join(DATA_DIR, 'product-weights.xlsx');
  if (!fs.existsSync(excelPath)) { console.log('product-weights.xlsx не найден — пропускаем'); return; }
  const xlsx = require('xlsx');
  const wb = xlsx.readFile(excelPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1 });
  let headerRow = -1, headers = [];
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    if (Array.isArray(rows[i]) && rows[i].includes('Артикул товара')) { headerRow = i; headers = rows[i]; break; }
  }
  if (headerRow < 0) { console.log('Не найдена строка заголовков в product-weights.xlsx — пропускаем'); return; }
  const artIdx = headers.indexOf('Артикул товара');
  const weightIdx = headers.indexOf('Вес товара');
  if (artIdx < 0 || weightIdx < 0) { console.log('Не найдены нужные колонки — пропускаем'); return; }

  function parseExcelWeight(val) {
    if (!val && val !== 0) return 0;
    const s = String(val).replace(',', '.').replace(/[  ]/g, ' ').trim();
    const m = s.match(/^(\d+(?:\.\d+)?)\s*(кг|г|kg|g|л|l|мл|ml)?$/i);
    if (!m) return 0;
    const value = parseFloat(m[1]);
    const unit = (m[2] || '').toLowerCase();
    if (unit === 'г' || unit === 'g') return value;
    if (unit === 'мл' || unit === 'ml') return value;
    return value * 1000;
  }

  const seen = new Set();
  const weightRows = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const art = String(r[artIdx] || '').trim();
    if (!art || seen.has(art)) continue;
    seen.add(art);
    const grams = parseExcelWeight(r[weightIdx]);
    if (grams > 0) weightRows.push({ article: art, grams });
  }
  await insertBatch(client, 'product_weights', ['article', 'grams'], ['article'], weightRows);
  console.log(`product_weights: ${weightRows.length} строк`);
}

async function main() {
  console.log('Создаём схему...');
  await createSchema();

  if (!fs.existsSync(DATA_DIR)) { console.log('data/ не существует — нечего переносить'); await pool.end(); return; }

  const dateDirs = fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name);

  console.log(`Найдено дат с данными: ${dateDirs.length}`);

  for (const dateStr of dateDirs) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const dirPath = path.join(DATA_DIR, dateStr);
      const hourFiles = fs.readdirSync(dirPath).filter(f => /^\d{2}\.json$/.test(f));
      for (const f of hourFiles) {
        const hour = parseInt(f.replace('.json', ''), 10);
        try { await migrateOpsFile(client, dateStr, hour, path.join(dirPath, f)); }
        catch (e) { console.error(`ops ${dateStr}/${f}:`, e.message); errors++; }
      }
      for (const [sub, fn] of [['placement', migratePlacementFile], ['receiving', migrateReceivingFile], ['remains', migrateRemainsFile]]) {
        const subDir = path.join(dirPath, sub);
        if (!fs.existsSync(subDir)) continue;
        const subFiles = fs.readdirSync(subDir).filter(f => /^\d{2}\.json$/.test(f));
        for (const f of subFiles) {
          const hour = parseInt(f.replace('.json', ''), 10);
          try { await fn(client, dateStr, hour, path.join(subDir, f)); }
          catch (e) { console.error(`${sub} ${dateStr}/${f}:`, e.message); errors++; }
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`Ошибка батча за ${dateStr}:`, e.message);
    } finally {
      client.release();
    }
    process.stdout.write(`\rОбработано дат: ${dateDirs.indexOf(dateStr) + 1}/${dateDirs.length}`);
  }
  console.log('');

  const shiftFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('shift_') && f.endsWith('.json'));
  console.log(`Легаси shift-файлов: ${shiftFiles.length}`);
  for (const f of shiftFiles) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await migrateLegacyShiftFile(client, path.join(DATA_DIR, f));
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`Ошибка легаси-файла ${f}:`, e.message);
    } finally {
      client.release();
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await migrateProductWeights(client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Ошибка product_weights:', e.message);
  } finally {
    client.release();
  }

  console.log(`Готово. wms_ops: ${opsCount}, wms_placement: ${placementCount}, wms_receiving: ${receivingCount}, wms_remains: ${remainsCount}, ошибок: ${errors}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
