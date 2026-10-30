const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const scheduler = require('./scheduler');
// склад запроса и папка его данных (см. warehouse-context.js)
const { dataDir, currentWarehouse, runWithWarehouse, DEFAULT_WAREHOUSE_ID } = require('./warehouse-context');
const vsAuth = require('./vs-auth-pg');
const productWeights = require('./product-weights');
const rkStorage = require('./route-rk-pg');
// всё хранение — PostgreSQL (режим JSON-файлов «USE_PG=false» убран 2026-10-31)
const emplPg = require('./empl-pg');
const tsdPg = require('./tsd-pg');
const motivationPg = require('./motivation-pg');
const wmsOpsPg = require('./wms-ops-pg');
const supplyPlansPg = require('./supply-plans-pg');
const consolidationPg = require('./consolidation-pg');
// небольшие данные node (перекличка, нарушения, настройки) — «склад + ключ → JSON»
const state = require('./state-pg');
const excelReports = require('./excel-reports');
const consolidationReports = require('./consolidation-reports');

const app = express();
app.use(cookieParser());
const PORT = process.env.PORT || 3000;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const AUTO_FETCH_SETTINGS_PATH = () => path.join(dataDir(), 'auto-fetch-settings.json');
try {
  app.use(require('compression')());
} catch (_) {
  // compression не установлен — сервер работает без gzip
}

// Размер тела запроса: 10 МБ всем, большой лимит — только сохранению выгрузок
// WMS (браузер присылает выгрузку за период одним запросом). Раньше было 1 ГБ
// на всё: несколько таких запросов могли съесть память сервера (swap нет).
const BIG_JSON_PATHS = new Set(['/api/save-fetched-data', '/api/stats/placement/save', '/api/stats/receiving/save', '/api/stats/remains/save']);
const jsonSmall = express.json({ limit: '10mb' });
const jsonBig = express.json({ limit: '300mb' });
app.use((req, res, next) => (BIG_JSON_PATHS.has(req.path) ? jsonBig : jsonSmall)(req, res, next));
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

const DEFAULT_CONFIG = {
  token: '',
  refreshToken: '',
  intervalMinutes: 60,
  pageSize: 500,
  apiUrl: 'https://api.samokat.ru/wmsops-wwh/stocks/changes/search',
  useVpn: true,
  cookie: '',
  telegramBotToken: '',
  telegramChatId: '',
  telegramThreadId: '',
  telegramThreadIdIdles: '',
  telegramChats: [], // [{ chatId, threadIdConsolidation?, threadIdStats?, threadIdIdles?, label? }] — несколько чатов/пользователей
  telegramTimezone: 'Europe/Moscow', // часовой пояс для времени в уведомлениях (например Europe/Kaliningrad для UTC+2)
};

const DEFAULT_AUTO_FETCH_SETTINGS = {
  fullRefreshTimes: ['09:10', '21:10'],
  incrementalMinutes: 30,
  incrementalLookbackMinutes: 40,
};

function normalizeTimeString(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function normalizeAutoFetchSettings(input = {}) {
  const rawTimes = Array.isArray(input.fullRefreshTimes)
    ? input.fullRefreshTimes
    : String(input.fullRefreshTimes || '').split(',');
  const fullRefreshTimes = [...new Set(rawTimes.map(normalizeTimeString).filter(Boolean))];
  const incrementalMinutes = Math.max(5, Math.min(240, Number(input.incrementalMinutes) || DEFAULT_AUTO_FETCH_SETTINGS.incrementalMinutes));
  const incrementalLookbackMinutes = Math.max(5, Math.min(240, Number(input.incrementalLookbackMinutes) || DEFAULT_AUTO_FETCH_SETTINGS.incrementalLookbackMinutes));
  return {
    ...DEFAULT_AUTO_FETCH_SETTINGS,
    fullRefreshTimes: fullRefreshTimes.length ? fullRefreshTimes : DEFAULT_AUTO_FETCH_SETTINGS.fullRefreshTimes,
    incrementalMinutes,
    incrementalLookbackMinutes,
  };
}

async function loadAutoFetchSettings() {
  const raw = await state.get('auto-fetch-settings', { legacyFile: AUTO_FETCH_SETTINGS_PATH() });
  return raw ? normalizeAutoFetchSettings(raw) : { ...DEFAULT_AUTO_FETCH_SETTINGS };
}

async function saveAutoFetchSettings(settings) {
  return state.set('auto-fetch-settings', normalizeAutoFetchSettings(settings));
}

function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { ...DEFAULT_CONFIG };
    const out = { ...DEFAULT_CONFIG, ...config };
    if (!Array.isArray(out.telegramChats)) out.telegramChats = [];
    // Миграция: старые чаты с одним threadId → раздельные (консолидация + статистика)
    for (const chat of out.telegramChats) {
      if (chat.threadId && !chat.threadIdConsolidation && !chat.threadIdStats) {
        chat.threadIdConsolidation = chat.threadId;
        chat.threadIdStats = chat.threadId;
      }
      if (chat.threadIdStats && !chat.threadIdIdles) {
        chat.threadIdIdles = chat.threadIdStats;
      }
      if (chat.enabled === undefined) chat.enabled = true;
      if (!Array.isArray(chat.companiesFilter)) chat.companiesFilter = [];
    }
    if (out.telegramChats.length === 0 && (out.telegramChatId || '').trim()) {
      out.telegramChats = [{
        chatId: String(out.telegramChatId).trim(),
        threadIdConsolidation: String(out.telegramThreadId || '').trim(),
        threadIdStats: String(out.telegramThreadId || '').trim(),
        threadIdIdles: String(out.telegramThreadIdIdles || out.telegramThreadId || '').trim(),
        label: '',
        enabled: true,
        companiesFilter: [],
      }];
    }
    return out;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Список чатов для отправки: из telegramChats, только enabled !== false. companiesFilter: пустой = все компании. */
function getTelegramChats(config) {
  const list = Array.isArray(config.telegramChats) && config.telegramChats.length > 0
    ? config.telegramChats
    : (config.telegramChatId && String(config.telegramChatId).trim()
      ? [{
          chatId: String(config.telegramChatId).trim(),
          threadIdConsolidation: String(config.telegramThreadId || '').trim(),
          threadIdStats: String(config.telegramThreadId || '').trim(),
          threadIdIdles: String(config.telegramThreadIdIdles || config.telegramThreadId || '').trim(),
          enabled: true,
          companiesFilter: [],
        }]
      : []);
  return list
    .filter(c => c.enabled !== false && String(c.chatId || '').trim())
    .map(c => ({
      chatId: String(c.chatId || '').trim(),
      threadIdConsolidation: parseTelegramThreadId(c.threadIdConsolidation) || parseTelegramThreadId(c.threadId),
      threadIdStats: parseTelegramThreadId(c.threadIdStats) || parseTelegramThreadId(c.threadId),
      threadIdIdles: parseTelegramThreadId(c.threadIdIdles) || parseTelegramThreadId(c.threadIdStats) || parseTelegramThreadId(c.threadId),
      companiesFilter: Array.isArray(c.companiesFilter) ? c.companiesFilter.filter(x => x != null && String(x).trim()) : [],
    }));
}

// Склад, выбранный сейчас в WMS у учётки токена (у учётки он один на все её
// сессии). Серверный сборщик собирает то, что отдаёт WMS, — значит, данные
// принадлежат этому складу: под ним их и сохраняем.
async function wmsWarehouseOfToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  try {
    const r = await fetch('https://api.samokat.ru/wmsops-wwh/warehouses/features-configuration', {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${t}`,
        Origin: 'https://wwh.samokat.ru',
        Referer: 'https://wwh.samokat.ru/',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data?.value?.warehouseId || null;
  } catch {
    return null;
  }
}


const fetchRequestedBy = new Set(); // склады, где попросили обновить данные

// API-маршруты регистрируем до статики, чтобы POST /api/empl и др. не отдавали index.html
// Открыт без входа: по нему Docker проверяет, жив ли node (healthcheck).
// Поэтому — только время обновления и флаг запроса; конфиг (там был токен
// Telegram-бота в открытом виде) больше не отдаётся.
app.get('/api/status', async (req, res) => {
  try {
    res.json({
      lastRun: await scheduler.getLastRun(),
      fetchRequested: fetchRequestedBy.has(currentWarehouse()),
    });
  } catch (err) {
    console.error('GET /api/status', err);
    res.status(500).json({ error: err.message });
  }
});






// Новые исполнители из выгрузки WMS — те, кого нет в списке сотрудников по
// executorId. ФИО — ровно как прислал WMS по этому ID: lastName firstName
// middleName, без правки регистра и «дописывания» отчеств. Уже записанных
// сотрудников система не меняет: ФИО правится только вручную в списке
// сотрудников. (Раньше здесь вёлся реестр по «фамилия + инициал», по нему
// переписывались ФИО в списке — чужими именами при совпадении ключа.)
async function updateNamesRegistry(items) {
  const itemNames = new Map(); // executorId -> fio
  for (const item of (items || [])) {
    const ru = item.responsibleUser || {};
    const id = String(ru.id || '').trim();
    const full = [ru.lastName, ru.firstName, ru.middleName].filter(Boolean).join(' ').trim();
    if (!id || !full || itemNames.has(id)) continue;
    itemNames.set(id, full);
  }

  const { idMap } = await getCompanyLookupMaps();
  const newEmployees = [];
  for (const [executorId, fio] of itemNames) {
    if (!idMap.has(executorId)) newEmployees.push({ executorId, fio });
  }
  return { newEmployees };
}

// ─── Консолидация: multer + paths ──────────────────────────────────────────
// фото жалоб — на диске сервера (папка подключена томом, её же раздаёт Caddy)
const UPLOADS_DIR = process.env.CONSOLIDATION_PHOTOS_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Фото жалоб приходят уже сжатыми браузером (до 1280 px, JPEG) вместе с
// миниатюрами — сервер их не разжимает и не пережимает, только сохраняет.
// Раньше сжатие здесь (sharp) забирало все ядра и сотни МБ памяти на фото.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/jpeg') cb(null, true);
    else cb(new Error('Только JPEG'));
  },
});
const isJpeg = buf => buf && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
const thumbName = name => name.replace(/\.jpg$/, '_t.jpg');
const complaintPhotos = c => (Array.isArray(c?.photoFilenames) && c.photoFilenames.length ? c.photoFilenames : (c?.photoFilename ? [c.photoFilename] : []));

const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function tgSafe(v) {
  return String(v == null ? '' : v).trim();
}

/** Экранирование для Telegram Markdown (* и _ в контенте не должны ломать разметку) */
function escapeTgMarkdown(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[');
}

function formatComplaintForTelegram(c, photoUrl, config = {}, companyResolved = null) {
  const dt = c?.operationCompletedAt || c?.createdAt || '';
  const tz = (config && config.telegramTimezone) || 'Europe/Moscow';
  const dateText = dt
    ? new Date(dt).toLocaleString('ru-RU', { timeZone: tz })
    : '—';
  const company = companyResolved != null ? companyResolved : (c.company != null && String(c.company).trim() !== '' ? c.company : '—');
  const v = (x) => escapeTgMarkdown(tgSafe(x) || '—');
  const dateEsc = escapeTgMarkdown(dateText);
  // Markdown: *текст* = жирный в Telegram
  return [
    `*Компания:* ${v(company)}`,
    `*Нарушитель:* ${v(c.violator)}`,
    `*Место:* ${v(c.cell)}`,
    `*ЕО:* ${v(c.handlingUnitBarcode)}`,
    `*ШК:* ${v(c.productBarcode)}`,
    `*Товар:* ${v(c.productName)}`,
    `*Время:* ${dateEsc}`,
    `*Фото:* ${photoUrl ? '✅' : '—'}`,
  ].join('\n');
}

function parseTelegramThreadId(value) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim();
  if (!v) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

async function sendTelegramMessage(botToken, chatId, text, threadId = null, parseMode = null) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (threadId) payload.message_thread_id = threadId;
  if (parseMode) payload.parse_mode = parseMode;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const e = new Error(data?.description || `Telegram API ${response.status}`);
    e.status = response.status;
    throw e;
  }
}

async function sendTelegramPhoto(botToken, chatId, caption, photoPath, photoFilename = 'photo.jpg', threadId = null, parseMode = null) {
  const fileBuf = fs.readFileSync(photoPath);
  return sendTelegramPhotoFromBuffer(botToken, chatId, caption, fileBuf, photoFilename, threadId, parseMode);
}

async function sendTelegramPhotoFromBuffer(botToken, chatId, caption, buffer, photoFilename = 'photo.png', threadId = null, parseMode = null) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendPhoto`;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (threadId) form.append('message_thread_id', String(threadId));
  if (caption) form.append('caption', caption);
  if (parseMode) form.append('parse_mode', parseMode);
  const blob = new Blob([buffer]);
  form.append('photo', blob, photoFilename);
  const response = await fetch(url, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const e = new Error(data?.description || `Telegram API ${response.status}`);
    e.status = response.status;
    throw e;
  }
}

async function sendTelegramMediaGroup(botToken, chatId, caption, files, threadId = null, parseMode = null) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMediaGroup`;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (threadId) form.append('message_thread_id', String(threadId));

  const media = files.map((f, i) => {
    const item = { type: 'photo', media: `attach://photo${i}` };
    if (i === 0 && caption) {
      item.caption = caption;
      if (parseMode) item.parse_mode = parseMode;
    }
    return item;
  });
  form.append('media', JSON.stringify(media));

  files.forEach((f, i) => {
    const buf = fs.readFileSync(f.path);
    const blob = new Blob([buf]);
    form.append(`photo${i}`, blob, f.name || `photo_${i + 1}.jpg`);
  });

  const response = await fetch(url, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const e = new Error(data?.description || `Telegram API ${response.status}`);
    e.status = response.status;
    throw e;
  }
}


// Запись в dotnet/Postgres кусками — один огромный POST упирается в лимит
// Kestrel (MaxRequestBodySize). Дедуп в dotnet сверяет каждый кусок с уже
// записанным, поэтому разбивка безопасна. Возвращает { added, skipped, error }.
const ITEMS_INGEST_CHUNK_SIZE = 10000;

async function ingestInChunks(url, items) {
  let added = 0;
  for (let i = 0; i < items.length; i += ITEMS_INGEST_CHUNK_SIZE) {
    const chunk = items.slice(i, i + ITEMS_INGEST_CHUNK_SIZE);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Warehouse': currentWarehouse() },
        body: JSON.stringify({ items: chunk }),
      });
      if (!r.ok) return { added, skipped: 0, error: `dotnet ingest HTTP ${r.status}` };
      const data = await r.json().catch(() => ({}));
      added += Number(data.added) || 0;
    } catch (err) {
      return { added, skipped: 0, error: err.message };
    }
  }
  return { added, skipped: Math.max(0, items.length - added), error: null };
}

// Комплектация и остальные операции из WMS (браузер забрал, сюда — сохранить):
// только в Postgres через dotnet. Почасовые JSON-файлы и .NET-утилиты tools/*
// больше не пишутся (2026-10-31) — их никто не читал, а диск рос на ~200 МБ в день.
app.post('/api/save-fetched-data', vsSessionRequired, async (req, res) => {
  try {
    const t0 = Date.now();
    const value = req.body?.value || req.body || {};
    const items = Array.isArray(value?.items) ? value.items : (Array.isArray(req.body?.items) ? req.body.items : []);
    const regResult = items.length > 0 ? await updateNamesRegistry(items) : { newEmployees: [] };
    const ingest = items.length > 0 ? await ingestInChunks('http://dotnet:5080/api/stats/ops/ingest', items) : { added: 0, skipped: 0, error: null };
    if (ingest.error) {
      console.error('/api/save-fetched-data: dotnet ingest failed:', ingest.error);
      return res.status(502).json({ ok: false, error: 'Не удалось сохранить в базу: ' + ingest.error });
    }
    // «Обновлено» в статистике = время последней реальной выгрузки
    await scheduler.setLastRun(new Date());
    // новые исполнители сразу видны в «Настройки → Сотрудники»
    invalidateExecutorsCache();
    res.json({
      ok: true,
      engine: 'postgres',
      added: ingest.added,
      skipped: ingest.skipped,
      itemsCount: items.length,
      newEmployees: regResult.newEmployees || [],
      timings: { totalMs: Date.now() - t0 },
    });
  } catch (err) {
    console.error('POST /api/save-fetched-data', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** { fioMap, idMap } — сотрудники и их компании из базы. */
async function getCompanyLookupMaps() {
  return emplPg.getLookupMaps();
}

/** Обратная совместимость для мест, которым нужна только карта ФИО→компания. */
async function getEmplMapFioToCompany() {
  return (await getCompanyLookupMaps()).fioMap;
}

function normalizeFioForMatch(fio) {
  return String(fio || '').trim().replace(/^-\s+/, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Нечёткий поиск компании по ФИО (точное совпадение / подстрока) — чистая функция над уже загруженной картой. */
function getCompanyByFio(emplMap, executorFio) {
  const norm = normalizeFioForMatch(executorFio);
  if (!norm) return null;
  for (const [key, company] of emplMap) {
    if (norm === key || norm.includes(key) || key.includes(norm)) return company;
  }
  return null;
}

/**
 * Компания определяется только по UUID executorId. ФИО используется только для отображения.
 * idMap — карта, уже загруженная вызывающим кодом за этот HTTP-запрос через
 * getCompanyLookupMaps().
 */
function getCompanyByIdOrFioSync(idMap, executorId, executorFio) {
  if (executorId && idMap) {
    const c = idMap.get(String(executorId).trim());
    if (c != null) return c;
  }
  return null;
}

// ─── Справочник товаров WMS: прокси для «Раскладки КДК» ────────────────────
// Единственный WMS-вызов проекта, который НЕЛЬЗЯ сделать из браузера, поэтому
// он и здесь, а не в wmsFetch.js. Справочник products/by-id живёт только в
// API терминала (wmsin-pdt): шлюз отвечает на CORS-preflight 403 для ЛЮБОГО
// Origin (проверено 2026-08-24), то есть дело не в нашем домене — эндпоинт
// закрыт для браузеров как класса. Веб-вариант того же пути (wmsin-wwh)
// preflight проходит, но сам отвечает TECHNICAL_ERROR. С сервера же CORS не
// действует и можно проставить user-agent приложения ТСД — браузеру этот
// заголовок менять запрещено.
//
// Токена WMS у сервера своего нет (как и везде в проекте) — фронт присылает
// свой, из текущей сессии пользователя, заголовком x-wms-token.
const PDT_PRODUCTS_BY_ID_URL = 'https://api.samokat.ru/wmsin-pdt/inbound/products/by-id';
// Подпись приложения ТСД: на этом пути WAF режет всё, что не похоже на
// терминал (обычный curl-agent получает 403). Значение — из реального запроса
// ТСД; вынесено в переменную окружения на случай, если его придётся сменить.
const PDT_USER_AGENT = process.env.WMS_PDT_USER_AGENT || '1686f906-cccc-4caf-9dbd-fd8a2908d17a';
const PDT_PRODUCTS_TIMEOUT_MS = 30000;

app.post('/api/wms/products-by-id', vsSessionRequired, async (req, res) => {
  const token = req.get('x-wms-token') || '';
  const productIds = Array.isArray(req.body?.productIds) ? req.body.productIds : [];
  if (!token) return res.status(400).json({ error: 'Нет WMS-токена' });
  if (!productIds.length) return res.status(400).json({ error: 'Пустой список productIds' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PDT_PRODUCTS_TIMEOUT_MS);
  try {
    const r = await fetch(PDT_PRODUCTS_BY_ID_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': PDT_USER_AGENT,
      },
      body: JSON.stringify({ productIds }),
    });
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch {
      return res.status(502).json({ error: `WMS вернул не JSON (${r.status}): ${text.slice(0, 150)}` });
    }
    if (!r.ok) return res.status(r.status).json({ error: data?.error || data?.message || `WMS ${r.status}` });
    res.json(data);
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'WMS не ответил за 30 секунд' });
    res.status(502).json({ error: err.message });
  } finally {
    clearTimeout(timer);
  }
});

// ─── Веса товаров: загрузка Excel (только админ) ───────────────────────────

const uploadWeightsExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname) ||
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel';
    if (ok) cb(null, true); else cb(new Error('Только Excel-файлы (.xlsx, .xls)'));
  },
});

const EXCEL_PATH = productWeights.EXCEL_PATH;

app.get('/api/vs/admin/product-weights/info', vsSessionRequired, vsAdminRequired, (req, res) => {
  try {
    const exists = fs.existsSync(EXCEL_PATH);
    if (!exists) return res.json({ exists: false, count: 0 });
    const stat = fs.statSync(EXCEL_PATH);
    const count = productWeights.getMap().size;
    res.json({ exists: true, updatedAt: stat.mtime.toISOString(), sizeBytes: stat.size, count, wmsCount: productWeights.wmsWeightsCount(), barcodes: productWeights.getBarcodeMap().size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vs/admin/product-weights/upload', vsSessionRequired, vsAdminRequired, uploadWeightsExcel.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    const map = productWeights.saveExcelBuffer(req.file.buffer);
    res.json({ ok: true, count: map.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Веса, которые браузер дозапросил у WMS (stocks/overview → measurements.weight)
// для товаров без веса в Excel: [{ article, grams, productId, name }].
app.post('/api/vs/admin/product-weights/wms', vsSessionRequired, vsAdminRequired, (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const saved = productWeights.addWmsWeights(items);
    res.json({ ok: true, saved, count: productWeights.getMap().size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/vs/admin/product-weights', vsSessionRequired, vsAdminRequired, (_req, res) => {
  try {
    productWeights.deleteExcel();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// GET /api/empl/find-unregistered — найти исполнителей из всех смен, которых нет в списке сотрудников
//
// Раньше на каждый запрос синхронно читались и парсились ВСЕ почасовые файлы
// data/YYYY-MM-DD/HH.json. Node однопоточный, поэтому на накопленной истории
// скан вешал весь сервер целиком — и тем сильнее, что «Настройки» зовут его
// автоматически при открытии страницы (EmployeesCard.jsx), у каждого
// пользователя. Теперь:
//   • при USE_PG=true список исполнителей берётся одним SQL по wms_ops —
//     файлы не читаются вообще, event loop не блокируется;
//   • файловый фоллбэк (установка без Postgres) читает асинхронно и только
//     изменившиеся даты: закрытые дни отдаются из кэша по stat-штампу;
//   • параллельные запросы делят один скан (single-flight), результат живёт
//     EXECUTORS_TTL_MS и сбрасывается после сохранения новых данных.
// Сверка с известными ID делается заново на каждый запрос — она дешёвая, а
// только что добавленный сотрудник должен сразу исчезать из выдачи.

const EXECUTORS_TTL_MS = 5 * 60 * 1000;
// по складу: { at, list: [{ executorId, fio }] } и Promise активного скана (single-flight)
const executorsCacheBy = new Map();
const executorsInflightBy = new Map();
function invalidateExecutorsCache() {
  executorsCacheBy.delete(currentWarehouse());
}

/** Исполнители из Postgres (wms_ops и остальные таблицы операций). */
async function collectExecutorsFromPg() {
  const rows = await wmsOpsPg.listExecutors();
  const out = [];
  for (const row of rows) {
    const executorId = String(row.executor_id || '').trim();
    const fio        = String(row.executor    || '').trim();
    if (!executorId || !fio) continue;
    out.push({ executorId, fio });
  }
  return out;
}

async function getAllExecutors() {
  const wh = currentWarehouse();
  const cached = executorsCacheBy.get(wh);
  if (cached && Date.now() - cached.at < EXECUTORS_TTL_MS) return cached.list;
  if (executorsInflightBy.has(wh)) return executorsInflightBy.get(wh);

  const inflight = (async () => {
    // только из базы: почасовых JSON-файлов больше нет (2026-10-31)
    const list = await collectExecutorsFromPg();
    executorsCacheBy.set(wh, { at: Date.now(), list });
    return list;
  })().finally(() => { executorsInflightBy.delete(wh); });
  executorsInflightBy.set(wh, inflight);
  return inflight;
}

app.get('/api/empl/find-unregistered', vsSessionRequired, async (req, res) => {
  try {
    // Собираем известные ID. ФИО не используется для сопоставления.
    const knownIds = new Set();
    const data = await emplPg.listEmployees();
    for (const e of data.employees) {
      if (e.executorId) knownIds.add(e.executorId);
    }

    const employees = (await getAllExecutors())
      .filter(e => !knownIds.has(e.executorId))
      .sort((a, b) => a.fio.localeCompare(b.fio, 'ru'));
    res.json({ employees });
  } catch (err) {
    console.error('GET /api/empl/find-unregistered', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Авторизация /vs: сессия + роли ─────────────────────────────────────────────

const VS_SESSION_COOKIE = 'vs_sid';

// ─── Привязка Telegram для менеджера (отчёты в личку) ─────────────────────────

async function getTelegramBotUsername(botToken) {
  if (!botToken || !botToken.trim()) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/getMe`);
    const data = await r.json();
    return data?.ok && data?.result?.username ? data.result.username : null;
  } catch {
    return null;
  }
}

app.get('/api/vs/telegram/status', vsSessionRequired, async (req, res) => {
  try {
    const login = req.vsSession?.login;
    const chatId = login ? await vsAuth.getTelegramChatId(login) : null;
    const config = loadConfig();
    const botToken = String(config.telegramBotToken || '').trim();
    let botUsername = null;
    if (botToken) botUsername = await getTelegramBotUsername(botToken);
    res.json({ linked: !!chatId, botUsername });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vs/telegram/bind-start', vsSessionRequired, async (req, res) => {
  try {
    const login = req.vsSession?.login;
    if (!login) return res.status(401).json({ error: 'Нет логина в сессии' });
    const config = loadConfig();
    const botToken = String(config.telegramBotToken || '').trim();
    if (!botToken) return res.status(400).json({ error: 'Бот не настроен (добавьте Bot Token в настройках)' });
    const code = vsAuth.createBindingCode();
    await vsAuth.addBindingCode(code, login);
    const botUsername = await getTelegramBotUsername(botToken);
    res.json({ code, botUsername: botUsername || '', expiresIn: 300 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Node agent: отключение ноды ──────────────────────────────────────────────

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

/** Middleware: доступ только для роли admin или developer, иначе 403. */
function vsAdminRequired(req, res, next) {
  const role = req.vsSession?.role;
  if (role !== 'admin' && role !== 'developer') {
    return res.status(403).json({ error: 'Требуются права администратора' });
  }
  next();
}

app.post('/api/vs/request-fetch', vsSessionRequired, (req, res) => {
  fetchRequestedBy.add(currentWarehouse());
  res.json({ ok: true });
});

app.get('/api/vs/auto-fetch-settings', vsSessionRequired, async (_req, res) => {
  try {
    res.json(await loadAutoFetchSettings());
  } catch (err) {
    console.error('GET /api/vs/auto-fetch-settings', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/vs/admin/auto-fetch-settings', vsSessionRequired, vsAdminRequired, async (req, res) => {
  try {
    res.json(await saveAutoFetchSettings(req.body || {}));
  } catch (err) {
    console.error('PUT /api/vs/admin/auto-fetch-settings', err);
    res.status(400).json({ error: err.message });
  }
});

// Ручной запрос обновления ЕО (`POST /eos/request-refresh` + очередь
// eoRefreshQueue) убран 2026-09-06 по просьбе пользователя: списки ЕО
// обновляются фоном сами, раз в 5 минут, устройством с включённым
// автообновлением (frontend-app/src/lib/eoAutoRefresh.jsx) — очередь
// «попроси другое устройство сходить в WMS» стала лишней сущностью.

// Корп. устройство вызывает после завершения полного runFetchForHours
app.post('/api/vs/mark-updated', vsSessionRequired, async (req, res) => {
  await scheduler.setLastRun(new Date());
  fetchRequestedBy.delete(currentWarehouse());
  res.json({ ok: true });
});

// ─── API админа /vs: пользователи, права, модули ─────────────────────────────────

// ─── Custom roles (admin) ────────────────────────────────────────────────────

// ─── Pending registration requests (admin) ───────────────────────────────────

// ─── API для страницы /vs (смены, дата, мониторинг, перекличка) ─────────────────

// placement из WMS (браузер забрал, сюда — сохранить):
// только в Postgres через dotnet. Почасовые JSON-файлы и .NET-утилиты tools/*
// больше не пишутся (2026-10-31) — их никто не читал, а диск рос на ~200 МБ в день.
app.post('/api/stats/placement/save', vsSessionRequired, async (req, res) => {
  try {
    const t0 = Date.now();
    const value = req.body?.value || req.body || {};
    const items = Array.isArray(value?.items) ? value.items : (Array.isArray(req.body?.items) ? req.body.items : []);
    const regResult = items.length > 0 ? await updateNamesRegistry(items) : { newEmployees: [] };
    const ingest = items.length > 0 ? await ingestInChunks('http://dotnet:5080/api/stats/placement/ingest', items) : { added: 0, skipped: 0, error: null };
    if (ingest.error) {
      console.error('/api/stats/placement/save: dotnet ingest failed:', ingest.error);
      return res.status(502).json({ ok: false, error: 'Не удалось сохранить в базу: ' + ingest.error });
    }
    res.json({
      ok: true,
      operation: 'placement',
      added: ingest.added,
      skipped: ingest.skipped,
      itemsCount: items.length,
      newEmployees: regResult.newEmployees || [],
      timings: { totalMs: Date.now() - t0 },
    });
  } catch (err) {
    console.error('POST /api/stats/placement/save', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// receiving из WMS (браузер забрал, сюда — сохранить):
// только в Postgres через dotnet. Почасовые JSON-файлы и .NET-утилиты tools/*
// больше не пишутся (2026-10-31) — их никто не читал, а диск рос на ~200 МБ в день.
app.post('/api/stats/receiving/save', vsSessionRequired, async (req, res) => {
  try {
    const t0 = Date.now();
    const value = req.body?.value || req.body || {};
    const items = Array.isArray(value?.items) ? value.items : (Array.isArray(req.body?.items) ? req.body.items : []);
    const regResult = items.length > 0 ? await updateNamesRegistry(items) : { newEmployees: [] };
    const ingest = items.length > 0 ? await ingestInChunks('http://dotnet:5080/api/stats/receiving/ingest', items) : { added: 0, skipped: 0, error: null };
    if (ingest.error) {
      console.error('/api/stats/receiving/save: dotnet ingest failed:', ingest.error);
      return res.status(502).json({ ok: false, error: 'Не удалось сохранить в базу: ' + ingest.error });
    }
    res.json({
      ok: true,
      operation: 'receiving',
      added: ingest.added,
      skipped: ingest.skipped,
      itemsCount: items.length,
      newEmployees: regResult.newEmployees || [],
      timings: { totalMs: Date.now() - t0 },
    });
  } catch (err) {
    console.error('POST /api/stats/receiving/save', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// remains из WMS (браузер забрал, сюда — сохранить):
// только в Postgres через dotnet. Почасовые JSON-файлы и .NET-утилиты tools/*
// больше не пишутся (2026-10-31) — их никто не читал, а диск рос на ~200 МБ в день.
app.post('/api/stats/remains/save', vsSessionRequired, async (req, res) => {
  try {
    const t0 = Date.now();
    const value = req.body?.value || req.body || {};
    const items = Array.isArray(value?.items) ? value.items : (Array.isArray(req.body?.items) ? req.body.items : []);
    const regResult = items.length > 0 ? await updateNamesRegistry(items) : { newEmployees: [] };
    const ingest = items.length > 0 ? await ingestInChunks('http://dotnet:5080/api/stats/remains/ingest', items) : { added: 0, skipped: 0, error: null };
    if (ingest.error) {
      console.error('/api/stats/remains/save: dotnet ingest failed:', ingest.error);
      return res.status(502).json({ ok: false, error: 'Не удалось сохранить в базу: ' + ingest.error });
    }
    res.json({
      ok: true,
      operation: 'remains',
      added: ingest.added,
      skipped: ingest.skipped,
      itemsCount: items.length,
      newEmployees: regResult.newEmployees || [],
      timings: { totalMs: Date.now() - t0 },
    });
  } catch (err) {
    console.error('POST /api/stats/remains/save', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Анализ: скорости сотрудников (СЗ/час) по истории ───────────────────────

const LIVE_MONITOR_URL = 'https://api.samokat.ru/wmsops-wwh/activity-monitor/selection/handling-units-in-progress';
const ROLLCALL_PATH = () => path.join(dataDir(), 'rollcall.json');


app.get('/api/monitor/live', vsSessionRequired, async (req, res) => {
  try {
    const config = loadConfig();
    const token = (config.token || '').trim();
    if (!token) return res.status(401).json({ error: 'Токен не задан' });
    // токен сервера смотрит в склад, выбранный у его учётки в WMS — данные
    // другого склада под выбранным на сайте не показываем
    const tokenWarehouse = await wmsWarehouseOfToken(token);
    if (tokenWarehouse && tokenWarehouse !== currentWarehouse()) {
      return res.status(409).json({ error: 'Серверный токен WMS настроен на другой склад' });
    }
    const headers = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Origin': 'https://wwh.samokat.ru',
      'Referer': 'https://wwh.samokat.ru/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    };
    const cookie = (config.cookie || '').trim();
    if (cookie) headers['Cookie'] = cookie;
    const response = await fetch(LIVE_MONITOR_URL, { headers });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch {
      return res.status(502).json({ error: 'Ответ не JSON', preview: text.slice(0, 200) });
    }
    if (!response.ok) return res.status(response.status).json({ error: `API ${response.status}`, data });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/rollcall', vsSessionRequired, async (req, res) => {
  try {
    res.json(await state.get('rollcall', { legacyFile: ROLLCALL_PATH(), fallback: { shiftKey: null, present: [] } }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rollcall', vsSessionRequired, async (req, res) => {
  try {
    const { shiftKey, present } = req.body || {};
    await state.set('rollcall', { shiftKey: shiftKey || null, present: present || [] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Консолидация: маршруты ──────────────────────────────────────────────────

// POST /api/consolidation/complaints — создать жалобу
app.post('/api/consolidation/complaints', vsSessionRequired, upload.fields([{ name: 'photo', maxCount: 10 }, { name: 'thumb', maxCount: 10 }]), async (req, res) => {
  try {
    const { cell, barcode, employeeName, handlingUnitBarcode } = req.body || {};
    const isZgh = (cell || '').trim().toUpperCase() === 'ZGH';
    if (isZgh && !handlingUnitBarcode) {
      return res.status(400).json({ ok: false, error: 'Укажите штрихкод ЕО' });
    }
    if (!isZgh && (!cell || !barcode)) {
      return res.status(400).json({ ok: false, error: 'Укажите место хранения и штрихкод' });
    }
    const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const uploaded = req.files?.photo || [];
    const thumbs = req.files?.thumb || [];
    const photoFilenames = [];
    for (let i = 0; i < uploaded.length; i++) {
      if (!isJpeg(uploaded[i].buffer)) continue;
      const newName = `${id}${i === 0 ? '' : `_${i + 1}`}.jpg`;
      await fs.promises.writeFile(path.join(UPLOADS_DIR, newName), uploaded[i].buffer);
      if (thumbs[i] && isJpeg(thumbs[i].buffer)) await fs.promises.writeFile(path.join(UPLOADS_DIR, thumbName(newName)), thumbs[i].buffer);
      photoFilenames.push(newName);
    }
    const photoFilename = photoFilenames[0] || null;
    const complaint = {
      id,
      createdAt: new Date().toISOString(),
      cell: cell.trim(),
      barcode: barcode ? barcode.trim() : '',
      employeeName: (employeeName || '').trim() || null,
      photoFilename,
      photoFilenames,
      handlingUnitBarcode: handlingUnitBarcode ? handlingUnitBarcode.trim() : null,
      productName: null,
      nomenclatureCode: null,
      productBarcode: null,
      violator: null,
      violatorId: null,
      operationType: null,
      operationCompletedAt: null,
      status: 'new',
      lookupDone: false,
      lookupError: null,
    };
    await consolidationPg.insert(complaint);
    res.json({ ok: true, id });
  } catch (err) {
    console.error('POST /api/consolidation/complaints', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/consolidation/complaints — список жалоб (компания из консолидации или по ФИО из empl)
app.get('/api/consolidation/complaints', vsSessionRequired, async (req, res) => {
  try {
    // from/to — ISO-границы даты подачи; компания без записи в жалобе — по ФИО (без сохранения)
    const list = await consolidationPg.list({ from: req.query.from || null, to: req.query.to || null });
    const emplMap = await getEmplMapFioToCompany();
    res.json(list.map(c => (c.company != null && String(c.company).trim() !== '')
      ? c
      : { ...c, company: getCompanyByFio(emplMap, c.violator) || '' }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/consolidation/export/report1 — детальный Excel (нарушения по компаниям)
app.post('/api/consolidation/export/report1', vsSessionRequired, async (req, res) => {
  try {
    const { dateFrom, dateTo, companyFullNames = {} } = req.body || {};
    const emplMap = await getEmplMapFioToCompany();
    let list = (await consolidationPg.list()).map(c => ({
      ...c,
      company: (c.company != null && String(c.company).trim() !== '')
        ? c.company
        : (getCompanyByFio(emplMap, c.violator) || ''),
    }));
    if (dateFrom) list = list.filter(c => c.createdAt >= new Date(dateFrom).toISOString());
    if (dateTo)   { const t = new Date(dateTo); t.setHours(23, 59, 59, 999); list = list.filter(c => c.createdAt <= t.toISOString()); }

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host     = req.headers['x-forwarded-host']  || req.get('host');
    const photoBaseUrl = `${protocol}://${host}/api/consolidation/uploads/`;

    const buffer = await consolidationReports.generateReport1(list, companyFullNames, photoBaseUrl);
    const fn = `Нарушения_${dateFrom || 'все'}_${dateTo || 'все'}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fn)}`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('POST /api/consolidation/export/report1', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/consolidation/export/report2 — сводный Excel (по компаниям + анализ)
app.post('/api/consolidation/export/report2', vsSessionRequired, async (req, res) => {
  try {
    const { dateFrom, dateTo, companyFullNames = {}, fineAmount = 0 } = req.body || {};
    const { fioMap: emplMap, idMap } = await getCompanyLookupMaps();
    const getComp = (fio, id) => getCompanyByIdOrFioSync(idMap, id, fio) || '—';

    let list = (await consolidationPg.list()).map(c => ({
      ...c,
      company: (c.company != null && String(c.company).trim() !== '')
        ? c.company
        : (getCompanyByFio(emplMap, c.violator) || ''),
    }));
    if (dateFrom) list = list.filter(c => c.createdAt >= new Date(dateFrom).toISOString());
    if (dateTo)   { const t = new Date(dateTo); t.setHours(23, 59, 59, 999); list = list.filter(c => c.createdAt <= t.toISOString()); }

    // Строим массив дат диапазона для листа «Анализ»
    const dateRange = [];
    const cur = new Date(dateFrom || list.reduce((m, c) => c.createdAt < m ? c.createdAt : m, new Date().toISOString()).slice(0, 10));
    const end = new Date(dateTo   || new Date().toISOString().slice(0, 10));
    while (cur <= end) {
      dateRange.push(cur.toISOString().slice(0, 10));
      cur.setDate(cur.getDate() + 1);
    }

    // Выход сотрудников по компаниям за каждый день диапазона — из базы
    // (комплектация в wms_ops), число уникальных сотрудников на компанию.
    const employeesByCompanyByDay = {};
    const pickers = dateRange.length ? await wmsOpsPg.pickersByShiftDate(dateRange[0], dateRange[dateRange.length - 1]) : [];
    const sets = {};
    for (const p of pickers) {
      const comp = getComp(p.executor, p.executorId);
      ((sets[p.date] = sets[p.date] || {})[comp] = sets[p.date][comp] || new Set()).add(p.executorId || normalizeFioForMatch(p.executor));
    }
    for (const dateStr of dateRange) {
      employeesByCompanyByDay[dateStr] = Object.fromEntries(Object.entries(sets[dateStr] || {}).map(([comp, s]) => [comp, { employees: s.size }]));
    }

    const buffer = await consolidationReports.generateReport2(list, companyFullNames, fineAmount, employeesByCompanyByDay, dateRange);
    const fn = `Сводка_нарушений_${dateFrom || 'все'}_${dateTo || 'все'}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fn)}`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('POST /api/consolidation/export/report2', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/consolidation/complaints/:id/status — сменить статус
app.put('/api/consolidation/complaints/:id/status', vsSessionRequired, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['new', 'in_progress', 'resolved'].includes(status)) {
      return res.status(400).json({ ok: false, error: 'Неверный статус' });
    }
    const item = await consolidationPg.patch(req.params.id, { status });
    if (!item) return res.status(404).json({ ok: false, error: 'Не найдено' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/consolidation/complaints/:id — удалить жалобу
app.delete('/api/consolidation/complaints/:id', vsSessionRequired, async (req, res) => {
  try {
    const removed = await consolidationPg.remove(req.params.id);
    if (!removed) return res.status(404).json({ ok: false, error: 'Не найдено' });
    // фото и миниатюры жалобы
    for (const file of complaintPhotos(removed)) {
      for (const name of [file, thumbName(file)]) await fs.promises.unlink(path.join(UPLOADS_DIR, path.basename(name))).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/consolidation/complaints/:id/lookup — сохранить результат WMS-поиска (от клиента)
app.put('/api/consolidation/complaints/:id/lookup', vsSessionRequired, async (req, res) => {
  try {
    const current = await consolidationPg.get(req.params.id);
    if (!current) return res.status(404).json({ ok: false, error: 'Не найдено' });
    const item = { ...current };
    const d = req.body || {};
    if (d.cell !== undefined) item.cell = d.cell;
    if (d.barcode !== undefined) item.barcode = d.barcode;
    if (d.productName !== undefined) item.productName = d.productName;
    if (d.nomenclatureCode !== undefined) item.nomenclatureCode = d.nomenclatureCode;
    if (d.productBarcode !== undefined) item.productBarcode = d.productBarcode;
    if (d.violator !== undefined) item.violator = d.violator;
    if (d.violatorId !== undefined) item.violatorId = d.violatorId;
    if (d.handlingUnitBarcode !== undefined) item.handlingUnitBarcode = d.handlingUnitBarcode;
    if (d.operationType !== undefined) item.operationType = d.operationType;
    if (d.operationCompletedAt !== undefined) item.operationCompletedAt = d.operationCompletedAt;
    if (d.lookupDone !== undefined) item.lookupDone = d.lookupDone;
    if (d.lookupError !== undefined) item.lookupError = d.lookupError;
    if (d.company !== undefined) item.company = d.company;
    if (d.taskArea !== undefined) item.taskArea = (d.taskArea === 'kdk' || d.taskArea === 'storage') ? d.taskArea : '';
    else if (d.operationType != null && (item.taskArea == null || String(item.taskArea).trim() === '')) {
      const op = String(d.operationType).toUpperCase();
      item.taskArea = (op === 'PICK_BY_LINE' || op.indexOf('PALLET') >= 0) ? 'kdk' : 'storage';
    }
    if (item.violator != null && (item.company == null || String(item.company).trim() === '')) {
      const emplMap = await getEmplMapFioToCompany();
      item.company = getCompanyByFio(emplMap, item.violator) || '';
    }
    const saved = await consolidationPg.patch(req.params.id, item);
    res.json({ ok: true, complaint: saved });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/consolidation/telegram/send — отправить выбранные жалобы в Telegram
app.post('/api/consolidation/telegram/send', vsSessionRequired, async (req, res) => {
  try {
    const complaintIds = Array.isArray(req.body?.complaintIds)
      ? req.body.complaintIds.map(x => String(x))
      : [];
    if (complaintIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'Не переданы complaintIds' });
    }

    const config = loadConfig();
    const botToken = String(config.telegramBotToken || '').trim();
    const chats = getTelegramChats(config);
    if (!botToken || !chats.length) {
      return res.status(400).json({ ok: false, error: 'Не настроены telegramBotToken или список чатов (Chat ID) в config' });
    }

    const selected = await consolidationPg.getMany(complaintIds);

    const onlyInProgress = selected.filter(c => c.status === 'in_progress');
    const skipped = selected.filter(c => c.status !== 'in_progress').map(c => c.id);
    if (onlyInProgress.length === 0) {
      return res.status(400).json({ ok: false, error: 'Выбранные жалобы не имеют статус "в работе"', skipped });
    }

    const sent = [];
    const failed = [];
    const origin = `${req.protocol}://${req.get('host')}`;
    const emplMap = await getEmplMapFioToCompany();
    for (const c of onlyInProgress) {
      const photos = Array.isArray(c?.photoFilenames) && c.photoFilenames.length > 0
        ? c.photoFilenames
        : (c?.photoFilename ? [c.photoFilename] : []);
      const photoUrl = photos.length > 0
        ? `${origin}/api/consolidation/uploads/${encodeURIComponent(photos[0])}`
        : '';
      const company = (c.company != null && String(c.company).trim() !== '') ? c.company : (getCompanyByFio(emplMap, c.violator) || '—');
      const text = formatComplaintForTelegram(c, photoUrl, config, company);
      const photoPaths = photos
        .map(name => ({ name, path: path.join(UPLOADS_DIR, name) }))
        .filter(x => fs.existsSync(x.path));
      let sentToAny = false;
      for (const chat of chats) {
        const threadId = chat.threadIdConsolidation;
        try {
          if (photoPaths.length > 1) {
            await sendTelegramMediaGroup(botToken, chat.chatId, text, photoPaths, threadId, 'Markdown');
          } else if (photoPaths.length === 1) {
            const p = photoPaths[0];
            await sendTelegramPhoto(botToken, chat.chatId, text, p.path, p.name, threadId, 'Markdown');
          } else {
            await sendTelegramMessage(botToken, chat.chatId, text, threadId, 'Markdown');
          }
          sentToAny = true;
        } catch (e) {
          failed.push({ id: c.id, error: e.message });
        }
      }
      if (sentToAny) sent.push(c.id);
    }

    res.json({
      ok: failed.length === 0,
      sentCount: sent.length,
      failedCount: failed.length,
      sent,
      failed,
      skipped,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Кэш дневной сводки по компаниям ─────────────────────────────────────────

// GET /api/shipments/missing-codes — ЦФЗ-адреса без кода получателя
app.get('/api/shipments/missing-codes', vsSessionRequired, async (req, res) => {
  try {
    const allAddresses = await rkStorage.getAddresses();
    const missing = excelReports.getMissingCodes(allAddresses);
    res.json(missing);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const ExcelJS = require('exceljs');
const XLSX    = require('xlsx');

// GET /api/shipments/codes — все адреса с текущими кодами получателей
app.get('/api/shipments/codes', vsSessionRequired, async (req, res) => {
  try {
    const allAddresses = await rkStorage.getAddresses();
    const codes = excelReports.getAddressCodes();
    const result = allAddresses.map(address => ({
      address,
      code: codes[address]?.sapCode || null,
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/shipments/codes/export — скачать Excel с адресами без кода
app.get('/api/shipments/codes/export', vsSessionRequired, async (req, res) => {
  try {
    const allAddresses = await rkStorage.getAddresses();
    const codes = excelReports.getAddressCodes();
    const missing = allAddresses.filter(a => !codes[a]);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Коды получателей');
    ws.columns = [
      { header: 'Адрес ЦФЗ',       key: 'address', width: 45 },
      { header: 'Код получателя',   key: 'code',    width: 20 },
    ];
    ws.getRow(1).font = { bold: true };
    missing.forEach(a => ws.addRow({ address: a, code: '' }));

    const buf = await wb.xlsx.writeBuffer();
    const filename = encodeURIComponent('Коды получателей ЦФЗ.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.send(buf);
  } catch (err) {
    console.error('GET /api/shipments/codes/export', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/shipments/codes/import — загрузить Excel с кодами получателей
app.post('/api/shipments/codes/import', vsSessionRequired, uploadExcel.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    let saved = 0;
    for (const row of rows) {
      const address = String(row['Адрес ЦФЗ'] || '').trim();
      const code    = String(row['Код получателя'] || '').trim();
      if (address && code) {
        excelReports.setAddressCode(address, code);
        saved++;
      }
    }
    res.json({ ok: true, saved });
  } catch (err) {
    console.error('POST /api/shipments/codes/import', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/shipments/set-code — привязать ЦФЗ-адрес к коду получателя
app.post('/api/shipments/set-code', vsSessionRequired, (req, res) => {
  try {
    const { address, code } = req.body;
    if (!address || !code) return res.status(400).json({ error: 'Нужны address и code' });
    excelReports.setAddressCode(address, code);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// GET /api/shipments/report?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD — скачать Excel-отчёт
app.get('/api/shipments/report', vsSessionRequired, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    if (!dateFrom || !dateTo) return res.status(400).json({ error: 'Нужны dateFrom и dateTo' });

    const [summaryData, allAddresses] = await Promise.all([
      rkStorage.getReportData(dateFrom, dateTo),
      rkStorage.getAddresses(),
    ]);

    const datesSet = new Set();
    summaryData.forEach(e => e.records.forEach(r => datesSet.add(r.date)));
    const dates = [...datesSet].sort();

    const buf = await excelReports.generateReport(summaryData, dates, dateFrom, allAddresses);

    const filename = encodeURIComponent('Отчет по РК, ящикам и ТЧ.xlsx');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.send(buf);
  } catch (err) {
    console.error('GET /api/shipments/report', err);
    res.status(500).json({ error: err.message });
  }
});


// ─── Отгрузка РК (маршрутная модель) ─────────────────────────────────────────

// Раздача фото
// ─── SSE: уведомления для VS-вкладки ─────────────────────────────────────────

// Thumbnails: генерируется при первом запросе, кешируется на диск
const THUMB_DIR = path.join(rkStorage.PHOTO_DIR, 'thumbs');
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

// ─── Опрос Telegram для привязки менеджеров (код в личку боту) ───────────────

let telegramPollingOffset = 0;

async function telegramBindingPollingLoop() {
  const config = loadConfig();
  const botToken = String(config.telegramBotToken || '').trim();
  if (!botToken) {
    setTimeout(telegramBindingPollingLoop, 15000);
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getUpdates?offset=${telegramPollingOffset}&timeout=25`;
    const r = await fetch(url);
    const data = await r.json().catch(() => ({}));
    if (data?.ok && Array.isArray(data.result)) {
      for (const upd of data.result) {
        if (upd.update_id >= telegramPollingOffset) telegramPollingOffset = upd.update_id + 1;
        const msg = upd.message || upd.edited_message;
        if (!msg?.text) continue;
        const text = String(msg.text).trim().toUpperCase();
        const chatId = msg.chat?.id;
        if (!chatId) continue;
        const login = await vsAuth.consumeBindingCode(text);
        if (login) {
          await vsAuth.setTelegramChatId(login, String(chatId));
          await sendTelegramMessage(botToken, chatId, '✅ Привязано. Отчёты по статистике будут приходить сюда.');
        }
      }
    }
  } catch (_) {
    // игнорируем ошибки сети — переподключимся через 5 сек
    await new Promise(r => setTimeout(r, 5000));
  }
  // следующий запрос стартует сразу после завершения предыдущего
  setImmediate(telegramBindingPollingLoop);
}

function startTelegramBindingPolling() {
  telegramBindingPollingLoop();
}

// ─── Нарушения (Violations) ─────────────────────────────────────────────────
const VIOLATIONS_DIR   = path.join(__dirname, 'data', 'violation-videos');
const VIOLATIONS_PATH  = () => path.join(dataDir(), 'violations.json');
if (!fs.existsSync(VIOLATIONS_DIR)) fs.mkdirSync(VIOLATIONS_DIR, { recursive: true });

const uploadViolation = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, VIOLATIONS_DIR),
    filename:    (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.mp4';
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Только видео-файлы'));
  },
});

// список нарушений — в базе (state-pg), видео — файлами в VIOLATIONS_DIR
async function loadViolations() {
  const list = await state.get('violations', { legacyFile: VIOLATIONS_PATH(), fallback: [] });
  return Array.isArray(list) ? list : [];
}
function saveViolations(data) {
  return state.set('violations', data);
}

// Раздача видео
app.get('/violation-videos/:filename', vsSessionRequired, (req, res) => {
  const file = path.join(VIOLATIONS_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Файл не найден' });
  res.sendFile(file);
});

// GET /api/violations
app.get('/api/violations', vsSessionRequired, async (_req, res) => {
  try { res.json(await loadViolations()); } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/violations — создать нарушение
app.post('/api/violations', vsSessionRequired, uploadViolation.single('video'), async (req, res) => {
  try {
    const { title, damage } = req.body;
    if (!title || !req.file) return res.status(400).json({ error: 'Нужны название и видео' });
    const violations = await loadViolations();
    const item = {
      id:        `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      title:     String(title).trim(),
      damage:    damage ? Number(damage) : null,
      videoFile: req.file.filename,
      createdAt: new Date().toISOString(),
    };
    violations.unshift(item);
    await saveViolations(violations);
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/violations/:id
app.delete('/api/violations/:id', vsSessionRequired, async (req, res) => {
  try {
    const violations = await loadViolations();
    const idx = violations.findIndex(v => v.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Не найдено' });
    const [removed] = violations.splice(idx, 1);
    await saveViolations(violations);
    const file = path.join(VIOLATIONS_DIR, removed.videoFile);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
// неизвестный адрес API — честный 404 в JSON, а не страница сайта со статусом 200
// (иначе ошибка в адресе или забытое правило Caddy выглядели как «пустой ответ»)
app.all('/api/*', (req, res) => res.status(404).json({ error: `Нет такого адреса API: ${req.method} ${req.path}` }));
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

async function startServer() {
  console.log('[pg] Инициализация PostgreSQL...');
  await rkStorage.init();
  await emplPg.init();
  await tsdPg.init();
  await motivationPg.init();
  await wmsOpsPg.init();
  await vsAuth.init();
  await productWeights.initPg();
  await supplyPlansPg.init();
  await consolidationPg.init();
  await state.init();
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  console.log('[pg] PostgreSQL готов');
  app.listen(PORT, '0.0.0.0', () => {
    scheduler.ensureDataDir();
    startTelegramBindingPolling();
    console.log(`Сервер: http://localhost:${PORT} (доступен по сети на порту ${PORT})`);
  });
}

startServer().catch(e => { console.error('Ошибка запуска сервера:', e); process.exit(1); });

