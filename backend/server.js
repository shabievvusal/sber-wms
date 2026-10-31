const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const scheduler = require('./scheduler');
// склад запроса и папка его данных (см. warehouse-context.js)
const { dataDir, currentWarehouse, runWithWarehouse, DEFAULT_WAREHOUSE_ID } = require('./warehouse-context');
const vsAuth = require('./vs-auth-pg');
// всё хранение — PostgreSQL (режим JSON-файлов «USE_PG=false» убран 2026-10-31)
const emplPg = require('./empl-pg');
const tsdPg = require('./tsd-pg');
const motivationPg = require('./motivation-pg');
const wmsOpsPg = require('./wms-ops-pg');
const supplyPlansPg = require('./supply-plans-pg');
// небольшие данные node (перекличка, нарушения, настройки) — «склад + ключ → JSON»
const state = require('./state-pg');
const app = express();
app.use(cookieParser());
const PORT = process.env.PORT || 3000;
try {
  app.use(require('compression')());
} catch (_) {
  // compression не установлен — сервер работает без gzip
}

// Размер тела запроса — 10 МБ (большие выгрузки WMS принимает dotnet, WmsSaveEndpoints.cs)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Склад запроса (заголовок X-Warehouse, ставит сайт): проверяем, что он
// пользователю доступен (vs_user_warehouses, см. vs-auth-pg.js applyWarehouse),
// и выполняем запрос «от имени» склада — дальше файлы данных, кэши и вызовы
// dotnet берут склад из warehouse-context.js. Без заголовка — СПБ-3, как было.
app.use(async (req, res, next) => {
  const asked = String(req.headers['x-warehouse'] || '').trim();
  if (!asked) return runWithWarehouse(DEFAULT_WAREHOUSE_ID, next);
  try {
    const sid = req.cookies?.[VS_SESSION_COOKIE];
    const session = sid ? await vsAuth.getSession(sid) : null;
    // без сессии заголовок не значит ничего (вход, старая вкладка) — как без него
    if (!session) return runWithWarehouse(DEFAULT_WAREHOUSE_ID, next);
    const scoped = await vsAuth.applyWarehouse(session, asked);
    if (!scoped) return res.status(403).json({ error: 'Нет доступа к этому складу' });
    return runWithWarehouse(asked, next);
  } catch (err) {
    return next(err);
  }
});

// ─── График поставок (supply-plans-pg.js) ────────────────────────────────────
// Excel из корп. почты или накопительный отчёт делопроизводителей — разбор
// в отдельном потоке (supply-plans-worker.js), строки заменяют свои даты.
function parseSupplyPlansInWorker(buffer) {
  const { Worker } = require('worker_threads');
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'supply-plans-worker.js'), { workerData: buffer });
    w.once('message', m => (m.error ? reject(new Error(m.error)) : resolve(m)));
    w.once('error', reject);
  });
}

// накопительный отчёт за полтора года весит ~25 МБ — общего лимита 20 МБ мало
const uploadSupplyPlans = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

app.post('/api/supply-plans/upload', vsSessionRequired, uploadSupplyPlans.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    const { rows, dayFacts } = await parseSupplyPlansInWorker(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: 'В файле не найден график: нужны колонки «Дата» и «Номер заказа»' });
    const saved = await supplyPlansPg.saveRows(rows);
    // накопительный отчёт: лист «статистика» — итоги факта по дням (история)
    const dayFactsSaved = await supplyPlansPg.saveDayFacts(dayFacts);
    res.json({ ok: true, ...saved, dayFacts: dayFactsSaved });
  } catch (err) {
    console.error('POST /api/supply-plans/upload', err);
    res.status(500).json({ error: err.message });
  }
});

// результат сверки с WMS за дату (по заказам + вне графика) — заменяет прежний
app.post('/api/supply-plans/facts', vsSessionRequired, async (req, res) => {
  try {
    const date = String(req.body?.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Нужна дата YYYY-MM-DD' });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    res.json({ ok: true, saved: await supplyPlansPg.saveFacts(date, rows) });
  } catch (err) {
    console.error('POST /api/supply-plans/facts', err);
    res.status(500).json({ error: err.message });
  }
});

// план + факт за период — накопительный отчёт и рейтинг поставщиков
app.get('/api/supply-plans/range', vsSessionRequired, async (req, res) => {
  try {
    const from = String(req.query.from || ''), to = String(req.query.to || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ error: 'Нужны from и to (YYYY-MM-DD)' });
    if ((new Date(to) - new Date(from)) / 86400000 > 400) return res.status(400).json({ error: 'Период не больше 400 дней' });
    res.json(await supplyPlansPg.getRange(from, to));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/supply-plans/dates', vsSessionRequired, async (req, res) => {
  try { res.json(await supplyPlansPg.listDates()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/supply-plans/kdk-history', vsSessionRequired, async (req, res) => {
  try {
    const days = Math.min(400, Math.max(14, parseInt(req.query.days, 10) || 120));
    res.json(await supplyPlansPg.kdkHistory(days));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/supply-plans', vsSessionRequired, async (req, res) => {
  try {
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Нужна дата YYYY-MM-DD' });
    res.json({ date, rows: await supplyPlansPg.getDay(date) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Авторизация /vs: сессия + роли ─────────────────────────────────────────────

const VS_SESSION_COOKIE = 'vs_sid';

/** Middleware: доступ только с валидной сессией /vs, иначе 401. */
async function vsSessionRequired(req, res, next) {
  try {
    const sessionId = req.cookies?.[VS_SESSION_COOKIE];
    const session = sessionId ? await vsAuth.getSession(sessionId) : null;
    if (!session) {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }
    // склад, выбранный на сайте: нет доступа — отказ; роль на складе своя —
    // подставляем, чтобы vsAdminRequired и хендлеры видели права на этом складе
    const scoped = await vsAuth.applyWarehouse(session, req.headers['x-warehouse']);
    if (!scoped) return res.status(403).json({ error: 'Нет доступа к этому складу' });
    req.vsSession = scoped;
    next();
  } catch (err) {
    next(err);
  }
}

// ─── React SPA (после всех API-маршрутов) ────────────────────────────────────
const DIST_DIR = path.join(__dirname, '..', 'frontend', 'app', 'dist');
// Файлы сборки Vite в /assets/ содержат хеш в имени (index-Ab12Cd.js) и после
// сборки не меняются — кэшируем на год, браузер больше не перепроверяет их при
// каждом открытии. fallthrough: false — отсутствующий бандл отдаёт 404, а не
// index.html со статусом 200 (иначе браузер падал на разборе HTML как JS).
// index.html, наоборот, no-cache: после деплоя браузер сразу получит новые
// имена бандлов. index: false — чтобы "/" тоже шёл через обработчик ниже.
app.use('/assets', express.static(path.join(DIST_DIR, 'assets'), { maxAge: '1y', immutable: true, fallthrough: false }));
app.use(express.static(DIST_DIR, { index: false }));
// проверка Docker, что node жив (docker-compose.yml healthcheck); без входа
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// неизвестный адрес API — честный 404 в JSON, а не страница сайта со статусом 200
// (иначе ошибка в адресе или забытое правило Caddy выглядели как «пустой ответ»)
app.all('/api/*', (req, res) => res.status(404).json({ error: `Нет такого адреса API: ${req.method} ${req.path}` }));
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

// Разовый перенос старых JSON-файлов склада в app_state (state-pg.js), пока они
// лежат на диске: читают эти данные уже и dotnet (перекличка, настройки,
// «Обновлено»), а он файлы не видит. Повторно безопасно — есть запись, файл не читается.
const LEGACY_STATE_FILES = { 'rollcall.json': 'rollcall', 'auto-fetch-settings.json': 'auto-fetch-settings', 'last-run.json': 'last-run', 'violations.json': 'violations' };
async function migrateLegacyStateFiles() {
  const { BASE_DATA_DIR } = require('./warehouse-context');
  const targets = [[DEFAULT_WAREHOUSE_ID, BASE_DATA_DIR]];
  const whRoot = path.join(BASE_DATA_DIR, 'warehouses');
  if (fs.existsSync(whRoot)) for (const d of fs.readdirSync(whRoot)) targets.push([d, path.join(whRoot, d)]);
  for (const [wh, dir] of targets) {
    for (const [file, key] of Object.entries(LEGACY_STATE_FILES)) {
      const legacyFile = path.join(dir, file);
      if (!fs.existsSync(legacyFile)) continue;
      try { await runWithWarehouse(wh, () => state.get(key, { legacyFile })); }
      catch (err) { console.error('[state] перенос', legacyFile, err.message); }
    }
  }
}

async function startServer() {
  console.log('[pg] Инициализация PostgreSQL...');
  await emplPg.init();
  await tsdPg.init();
  await motivationPg.init();
  await wmsOpsPg.init();
  await vsAuth.init();
  await supplyPlansPg.init();
  await state.init();
  await migrateLegacyStateFiles();
  console.log('[pg] PostgreSQL готов');
  app.listen(PORT, '0.0.0.0', () => {
    scheduler.ensureDataDir();
    console.log(`Сервер: http://localhost:${PORT} (доступен по сети на порту ${PORT})`);
  });
}

startServer().catch(e => { console.error('Ошибка запуска сервера:', e); process.exit(1); });

