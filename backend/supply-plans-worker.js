// Разбор Excel графика поставок в отдельном потоке: накопительный отчёт
// (сотни листов) читается ~10 с — в основном потоке это подвешивало бы
// весь сайт на время загрузки. См. supply-plans-pg.js parseWorkbook.
const { parentPort, workerData } = require('worker_threads');
const { parseWorkbook } = require('./supply-plans-pg');

try {
  parentPort.postMessage({ rows: parseWorkbook(Buffer.from(workerData)) });
} catch (err) {
  parentPort.postMessage({ error: err.message });
}
