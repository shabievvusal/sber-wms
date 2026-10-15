// Склад текущего запроса (РЦ) — данные каждого склада на сайте отдельно.
//
// Сайт присылает выбранный склад заголовком X-Warehouse (frontend-app/src/lib/api.js).
// Middleware в server.js проверяет, что склад пользователю доступен, и кладёт
// его сюда — в AsyncLocalStorage: дальше любой код запроса (и фоновые задачи,
// запущенные из него) берёт склад через currentWarehouse(), без протаскивания
// параметра через все функции. Без заголовка — СПБ-3, как было до разделения.
//
// Файлы данных склада (почасовые JSON, реестр имён, неучтённые веса,
// перекличка, нарушения, жалобы, настройки автообновления…) — в своей папке:
// у СПБ-3 прежняя data/ (ничего не переносится), у остальных
// data/warehouses/<id склада>/.
const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');

const DEFAULT_WAREHOUSE_ID = '0087831f-9906-11ee-8861-08c0eb32014b'; // СПБ-3
const BASE_DATA_DIR = path.join(__dirname, 'data');

const store = new AsyncLocalStorage();

function currentWarehouse() {
  return store.getStore() || DEFAULT_WAREHOUSE_ID;
}

/** Выполнить fn «от имени» склада (запрос, фоновая выгрузка). */
function runWithWarehouse(warehouseId, fn) {
  return store.run(warehouseId || DEFAULT_WAREHOUSE_ID, fn);
}

function safeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9-]/g, '');
}

/** Папка данных склада (создаётся при первом обращении). */
function dataDir(warehouseId = currentWarehouse()) {
  if (!warehouseId || warehouseId === DEFAULT_WAREHOUSE_ID) return BASE_DATA_DIR;
  const dir = path.join(BASE_DATA_DIR, 'warehouses', safeId(warehouseId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Значение «на склад»: по ключу склада своя копия (кэши, флаги, статусы). */
function perWarehouse(init) {
  const map = new Map();
  return (warehouseId = currentWarehouse()) => {
    if (!map.has(warehouseId)) map.set(warehouseId, init());
    return map.get(warehouseId);
  };
}

module.exports = {
  DEFAULT_WAREHOUSE_ID,
  BASE_DATA_DIR,
  currentWarehouse,
  runWithWarehouse,
  dataDir,
  perWarehouse,
};
