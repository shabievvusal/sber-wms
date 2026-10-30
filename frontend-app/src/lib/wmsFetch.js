// Единственное место в проекте, где JS обязан работать в браузере: получение
// данных из wwh.samokat.ru требует токена ТЕКУЩЕЙ сессии пользователя — сервер
// сходить туда сам не может. Портировано как есть из
// ../../zlp-main-main/frontend/app/src/api/index.js (fetchRkFromWms), без
// логики уровня приложения — только сеть.

import { apiHeaders, saveWmsWeights } from '@/lib/api'

const WMS_ROUTES_BASE = 'https://api-p01.samokat.ru/wmsout-wwh/shipments/routes'
const LIVE_MONITOR_URL = 'https://api.samokat.ru/wmsops-wwh/activity-monitor/selection/handling-units-in-progress'
const SAMOKAT_STOCKS_URL = 'https://api.samokat.ru/wmsops-wwh/stocks/changes/search'
const PIECE_SELECTION_TASKS_URL = 'https://api-p01.samokat.ru/wmsout-wwh/picking-selection/tasks'
const PLACEMENT_TASKS_URL = 'https://api.samokat.ru/wmsin-wwh/placement/tasks'
const REMAINS_TASKS_URL = 'https://api.samokat.ru/wmsin-wwh/storage-zone-movements/consolidation/tasks'
const MONITORING_STATS_URL = 'https://api.samokat.ru/wmsops-wwh/activity-monitor/selection/stats'
const INBOUND_TASKS_URL = 'https://api.samokat.ru/wmsin-wwh/inbound/tasks'
const MOVEMENTS_URL = 'https://api-p01.samokat.ru/wmsout-wwh/movements/picking-refill/tasks'
const SHIPMENT_ORDERS_URL = 'https://api-p01.samokat.ru/wmsout-wwh/shipment-order/shipments'
// склад, выбранный сейчас в WMS у учётки (у учётки он один на все её сессии)
const WMS_FEATURES_URL = 'https://api.samokat.ru/wmsops-wwh/warehouses/features-configuration'
const WMS_SHIFTS_URL = 'https://api.samokat.ru/wmsin-wwh/shifts'
const PRODUCTS_SEARCH_URL = 'https://api.samokat.ru/wmsops-wwh/products/search'
const STOCKS_OVERVIEW_URL = 'https://api.samokat.ru/wmsops-wwh/stocks/overview'
const TOPOLOGY_CELLS_FIND_URL = 'https://api.samokat.ru/wmsops-wwh/topology/v2/cells/find'
// Тип поставки → сегмент адреса inbound/{slug}/tasks. «На хранение от РЦ» —
// storage-dc через дефис (так ходит сам WMS); с storage_dc запросы приёмщика
// и карточки таких поставок падали, и они выпадали из статистики приёмки.
const INBOUND_TYPE_SLUG = { CROSSDOCK: 'crossdock', IMPORT: 'import', STORAGE: 'storage', STORAGE_DC: 'storage-dc' }

const LS_ACCESS_KEY = 'wms_access_token'
const LS_ACCESS_EXPIRY_KEY = 'wms_access_token_expiry'

// Общий геттер токена — раньше был задублирован в FetchModal.jsx, вынесен
// сюда (единственная разница с дублем: теперь один источник истины для
// всех потребителей wmsFetch.js).
export function getStoredToken() {
  const token = localStorage.getItem(LS_ACCESS_KEY)
  const expiry = localStorage.getItem(LS_ACCESS_EXPIRY_KEY)
  if (!token) return null
  if (expiry && Date.now() > Number(expiry) - 60000) return null
  return token
}

function wmsHeaders(token) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    Origin: 'https://wwh.samokat.ru',
    Referer: 'https://wwh.samokat.ru/',
  }
}

async function wmsGet(url, token) {
  const r = await fetch(url, { headers: wmsHeaders(token) })
  const text = await r.text()
  const trimmed = (text || '').trim().toLowerCase()
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    throw new Error('WMS вернул HTML — токен устарел. Обновите страницу и войдите заново.')
  }
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error('WMS вернул не JSON: ' + (text || '').slice(0, 150))
  }
  if (!r.ok) throw new Error(`WMS ${r.status}: ${data?.message || data?.error || r.statusText}`)
  return data
}

// ─── Склад учётки в WMS ─────────────────────────────────────────────────────
// Данные из WMS приходят по складу, выбранному сейчас у учётки (в шапке WMS;
// он один на все сессии учётки). Поэтому всё, что сохраняется у нас,
// помечается именно этим складом — а не выбранным на сайте: иначе данные
// одного склада попали бы в другой.
let wmsWarehouseCache = { token: null, id: null, at: 0 }

/** id склада, выбранного сейчас в WMS у учётки токена (кэш 1 мин). */
export async function getWmsWarehouseId(token, { fresh = false } = {}) {
  if (!token) return null
  if (!fresh && wmsWarehouseCache.token === token && Date.now() - wmsWarehouseCache.at < 60_000) return wmsWarehouseCache.id
  const data = await wmsGet(WMS_FEATURES_URL, token)
  const id = data?.value?.warehouseId || null
  wmsWarehouseCache = { token, id, at: Date.now() }
  return id
}

/** Сменить склад в WMS — как выбор склада в шапке WMS: склад в WMS — это
 *  открытая смена, поэтому текущая закрывается (shifts/close) и открывается
 *  новая на нужном складе (shifts). Меняется во всех сессиях учётки — только
 *  по явному нажатию пользователя. */
export async function switchWmsWarehouse(token, warehouseId) {
  // WMS сообщает об ошибке полем error — бывает и при HTTP 200
  // (USER_ALREADY_HAS_A_SHIFT приходит так), поэтому смотрим и статус, и тело
  const post = async (url, body) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { ...wmsHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    let data = null
    try { data = await r.json() } catch { /* пустой ответ — ок */ }
    const error = data?.error || (r.ok ? '' : String(r.status))
    return { ok: !error, error }
  }

  let res = await post(WMS_SHIFTS_URL, { warehouseId })
  if (res.error === 'USER_ALREADY_HAS_A_SHIFT') {
    const closed = await post(WMS_SHIFTS_URL + '/close', {})
    if (!closed.ok) throw new Error(`WMS не закрыл текущую смену: ${closed.error}`)
    res = await post(WMS_SHIFTS_URL, { warehouseId })
  }
  if (!res.ok) throw new Error(`WMS не сменил склад: ${res.error}`)
  // проверяем, что склад в WMS действительно сменился
  const now = await getWmsWarehouseId(token, { fresh: true }).catch(() => null)
  if (now && now !== warehouseId) throw new Error('WMS не сменил склад — смените его в шапке WMS')
  wmsWarehouseCache = { token, id: warehouseId, at: Date.now() }
  return true
}

// Живой снимок операций в процессе — MonitorPage.jsx использует его вместо
// same-origin api.getLiveMonitor(), когда есть настоящий WMS-токен.
export async function getLiveMonitorViaBrowser(token) {
  return wmsGet(LIVE_MONITOR_URL, token)
}

// Обновление ЕО по одному маршруту (CfzEoPanel.jsx) — своя реализация,
// не через wmsGet(): в оригинале у неё отдельный 20-секундный таймаут через
// AbortController (нет окружающей ретрай-логики, как у bulk-фетчей выше).
export async function fetchRouteFromWMS(token, routeId) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  let r
  try {
    r = await fetch(`${WMS_ROUTES_BASE}/${encodeURIComponent(routeId)}`, {
      method: 'GET',
      signal: controller.signal,
      headers: wmsHeaders(token),
    })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('WMS не ответил за 20 секунд. Проверьте интернет или попробуйте позже.')
    throw err
  } finally {
    clearTimeout(timer)
  }
  const text = await r.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error('Ответ не JSON: ' + (text || '').slice(0, 150))
  }
  if (!r.ok) throw new Error(`WMS HTTP ${r.status}: ${data?.message || data?.error || r.statusText}`)
  return data
}

// ─── Комплектация (КДК + штучный отбор) ─────────────────────────────────────

async function samokatPost(token, url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...wmsHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  const trimmed = (text || '').trim().toLowerCase()
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    throw new Error('Нет доступа к API. Проверьте VPN или войдите заново.')
  }
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error('Ответ не JSON: ' + (text || '').slice(0, 150))
  }
  if (!r.ok) throw new Error(`API ${r.status}: ${data?.message || data?.error || r.statusText}`)
  return data
}

export async function getPieceSelectionTasks(token, {
  pageNumber = 1,
  pageSize = 100,
  dateFrom,
  dateTo,
  status,
  shipToId = null,
  sourceZoneId = null,
  shipmentTemperatureMode = null,
  shipmentNumber = null,
  routeNumber = null,
  targetHandlingUnitBarcode = null,
  responsibleUserId = null,
} = {}) {
  return samokatPost(token, PIECE_SELECTION_TASKS_URL, {
    dateFrom, dateTo, status, shipToId, sourceZoneId, shipmentTemperatureMode,
    shipmentNumber, routeNumber, targetHandlingUnitBarcode, responsibleUserId,
    pageNumber, pageSize,
  })
}

// ─── Раскладка КДК (KdkPlacementPage.jsx) ───────────────────────────────────
// Единственный раздел проекта, который ходит не в `wmsout-wwh` (веб-интерфейс
// WMS), а в `wmsout-pdt` — API терминала сборщика (`pbl` = pick-by-line = КДК).
// Все три эндпоинта — GET без тела, подтверждены реальными запросами из
// DevTools (Copy as cURL, 2026-08-21). Служебные заголовки того curl
// (sentry-trace/baggage/Cookie/Host/user-agent с UUID приложения ТСД) не
// воспроизводим: Cookie/Host браузер ставит сам, user-agent подменить не
// даёт, а трассировка Sentry — чужая. Первый ответ шлюза может быть 307 на
// самого себя (ставит cookies spid/spsc) — fetch отрабатывает это прозрачно,
// как и на уже работающих `wmsout-wwh` вызовах.

const PBL_ZONES_URL = 'https://api-p01.samokat.ru/wmsout-pdt/pbl/zones'
const PBL_TASKS_URL = 'https://api-p01.samokat.ru/wmsout-pdt/pbl/tasks'
const PBL_TASK_BY_BARCODE_URL = `${PBL_TASKS_URL}/by-handling-unit-barcode`
const PRODUCTS_BY_ID_PROXY_URL = '/api/wms/products-by-id'

/** Список зон-ворот КДК с количеством стоящих на них ЕО. */
export async function getPblZones(token) {
  return wmsGet(PBL_ZONES_URL, token)
}

/** Детализация ворот: поставки (receipts) и ЕО, стоящие на этих воротах. */
export async function getPblGate(token, gateId) {
  return wmsGet(`${PBL_ZONES_URL}/gates/${encodeURIComponent(gateId)}`, token)
}

/**
 * Задача раскладки по ШК ЕО — шаги (ячейки) и товар с плановым/принятым
 * количеством. Отдаёт задачу, только пока её никто не взял: на взятую в
 * работу отвечает PBL_WRONG_TASK_STATUS (проверено 24.08.2026).
 */
export async function getPblTaskByBarcode(token, barcode) {
  return wmsGet(`${PBL_TASK_BY_BARCODE_URL}/${encodeURIComponent(barcode)}`, token)
}

// Задачи, УЖЕ ВЗЯТОЙ В РАБОТУ, получить пока нечем — обе проверенные
// 24.08.2026 попытки отвергнуты самим WMS:
//   • по ШК ЕО (getPblTaskByBarcode)   → PBL_WRONG_TASK_STATUS
//   • по id записи монитора, /pbl/tasks/{id} → NOT_FOUND (сервис путь понял,
//     значит id записи «handling unit in progress» — не id задачи)
// Из-за этого в «Зависших задачах» нет остатка степов. Следующий шаг — снять
// реальный запрос с ТСД в момент раскладки, а не подбирать адрес.

// Справочник товаров по списку productId — в задаче раскладки лежит только
// UUID товара, а название и вес штуки (`weightInGrams`) берутся отсюда.
//
// ЕДИНСТВЕННЫЙ WMS-вызов проекта, который идёт НЕ напрямую из браузера:
// эндпоинт живёт только в API терминала (wmsin-pdt) и отвечает на
// CORS-preflight 403 для любого Origin, а веб-вариант того же пути —
// TECHNICAL_ERROR. Поэтому ходим через свой бэкенд (POST /api/wms/products-by-id,
// см. server.js), туда же передаём WMS-токен текущей сессии — сервер своего
// не имеет. Ответ отдаётся как есть, в том же виде `{ value: { products } }`.
export async function getProductsById(token, productIds) {
  const r = await fetch(PRODUCTS_BY_ID_PROXY_URL, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-WMS-Token': token },
    body: JSON.stringify({ productIds }),
  })
  const text = await r.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error(`Сервер вернул не JSON (${r.status}): ${text.slice(0, 150)}`)
  }
  if (!r.ok) throw new Error(data?.error || r.statusText || `HTTP ${r.status}`)
  return data
}

// «Пропуски в отборе» (PickingGapsPage.jsx) — список заказов на отгрузку
// (склад «Хранение») и детали одного заказа с товарами. Тело POST-запроса
// подтверждено реальным запросом из DevTools (Copy as cURL), поля кроме
// перечисленных ниже в оригинале всегда null — не добавляем лишних
// параметров, которых не видели в реальном вызове.
export async function getShipmentOrders(token, {
  pageNumber = 1,
  pageSize = 100,
  shippedDateFrom,
  shippedDateTo,
  status,
  temperatureMode = null,
} = {}) {
  return samokatPost(token, SHIPMENT_ORDERS_URL, {
    shipmentNumber: null, orderId: null, shipmentType: null, routeNumber: null,
    shippedDateFrom, shippedDateTo, status,
    incompleteReservationsOnly: null, availableForCorrectionOnly: null,
    cityId: null, shipToId: null, temperatureMode,
    correctedOnly: null, pageNumber, pageSize,
  })
}

export async function getShipmentOrderDetail(token, id) {
  return wmsGet(`${SHIPMENT_ORDERS_URL}/${encodeURIComponent(id)}`, token)
}

// Последний завершённый пик КДК (PICK_BY_LINE) для исполнителя —
// KdkLayoutPage.jsx использует это, чтобы узнать остаток штук и время
// простоя. Переиспользует _fetchOnePageFromBrowser (тот же эндпоинт
// stocks/changes/search, что и общий фетч данных Фазы 1).
export async function fetchLastKdkCompletedForExecutor(token, executorId) {
  const body = {
    productId: null, parts: [], operationTypes: [],
    sourceCellId: null, targetCellId: null,
    sourceHandlingUnitBarcode: null, targetHandlingUnitBarcode: null,
    operationStartedAtFrom: null, operationStartedAtTo: null,
    operationCompletedAtFrom: null, operationCompletedAtTo: null,
    executorId: executorId || null,
    pageNumber: 1, pageSize: 100,
  }
  const { items } = await _fetchOnePageFromBrowser(token, body)
  let lastItem = null
  let maxCompletedAt = null
  for (const item of items) {
    if (item.operationType && item.operationType !== 'PICK_BY_LINE') continue
    const at = item.operationCompletedAt
    if (!at) continue
    const ts = new Date(at).getTime()
    if (maxCompletedAt === null || ts > maxCompletedAt) {
      maxCompletedAt = ts
      lastItem = item
    }
  }
  return {
    items,
    lastItem,
    maxCompletedAt,
    remainingPieces: lastItem?.sourceQuantity?.newQuantity ?? null,
  }
}

// Последняя завершённая задача (любого типа) для исполнителя в заданном
// диапазоне дат — MonitorPage.jsx использует это, чтобы точечно уточнить
// время последнего пика для КАЖДОГО сотрудника из переклички поверх общей
// сводки за смену (monitorItems/статистика) — тот же общий поиск
// (stocks/changes/search), что и общий фетч данных/fetchLastKdkCompletedForExecutor
// выше, просто без фильтра по типу операции и с диапазоном дат.
export async function fetchLastCompletedForExecutor(token, executorId, fromIso, toIso) {
  const body = {
    productId: null, parts: [], operationTypes: [],
    sourceCellId: null, targetCellId: null,
    sourceHandlingUnitBarcode: null, targetHandlingUnitBarcode: null,
    operationStartedAtFrom: null, operationStartedAtTo: null,
    operationCompletedAtFrom: fromIso, operationCompletedAtTo: toIso,
    executorId: executorId || null,
    pageNumber: 1, pageSize: 100,
  }
  const { items } = await _fetchOnePageFromBrowser(token, body)
  let maxCompletedAt = null
  for (const item of items) {
    const at = item.operationCompletedAt
    if (!at) continue
    const ts = new Date(at).getTime()
    if (maxCompletedAt === null || ts > maxCompletedAt) maxCompletedAt = ts
  }
  return { items, maxCompletedAt }
}

export async function fetchRkFromWms({ dateFrom, dateTo, token, onProgress }) {
  const fromIso = new Date(dateFrom + 'T00:00:00+03:00').toISOString()
  const toIso = new Date(dateTo + 'T23:59:59+03:00').toISOString()

  function buildParams(pageNumber, pageSize) {
    const p = new URLSearchParams({ dateFrom: fromIso, dateTo: toIso, pageNumber, pageSize })
    p.append('status', 'PACKAGING')
    p.append('status', 'COMPLETED')
    return p
  }

  const pageSize = 100
  const firstData = await wmsGet(`${WMS_ROUTES_BASE}?${buildParams(1, pageSize)}`, token)
  const first = firstData?.value ?? firstData
  const total = first?.total || 0
  const rawItems = [...(first?.items || [])]
  const pages = Math.ceil(total / pageSize)
  for (let p = 2; p <= pages; p++) {
    const d = await wmsGet(`${WMS_ROUTES_BASE}?${buildParams(p, pageSize)}`, token)
    rawItems.push(...((d?.value ?? d)?.items || []))
  }
  const seen = new Set()
  const items = rawItems.filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true })

  onProgress?.(`Маршрутов: ${items.length}. Загружаю детали...`)

  const routeDetails = []
  const BATCH = 5
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH)
    const details = await Promise.all(
      batch.map(item => wmsGet(`${WMS_ROUTES_BASE}/${encodeURIComponent(item.id)}`, token).catch(e => ({ _error: e.message })))
    )
    for (const d of details) { if (!d._error) routeDetails.push(d) }
    onProgress?.(`Загружено деталей: ${routeDetails.length} / ${items.length}...`)
  }

  // маршруты — в склад, выбранный сейчас в WMS (откуда они и пришли)
  const wmsWarehouse = await getWmsWarehouseId(token).catch(() => null)
  const r = await fetch('/api/rk/import-bulk', {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json', ...(wmsWarehouse ? { 'X-Warehouse': wmsWarehouse } : {}) }),
    body: JSON.stringify({ routes: routeDetails }),
    credentials: 'include',
  })
  return r.json()
}

// ─── Общий фетч данных (ops + placement + remains) ─────────────────────────
// Порт fetchDataViaBrowser/fetchPlacementViaBrowser/fetchRemainsViaBrowser
// из оригинала (api/index.js). Каждая — своя пагинация по WMS, а сохранение
// результата — POST в свой же бэкенд (тот же /api/save-fetched-data и
// /api/stats/{placement,remains}/save, что уже вызывают same-origin пути в
// new zlp — эти функции просто дают им реальные данные вместо демо-фетча).

// Сохранение выгрузки у нас — со складом, выбранным сейчас в WMS (см. выше).
// Не удалось узнать склад в WMS — выбранный на сайте. `wrap: false` — тело
// уходит как есть, без обёртки { value }.
async function postOwnBackend(url, value, token, { wrap = true } = {}) {
  const warehouseId = (await getWmsWarehouseId(token).catch(() => null)) || null
  const r = await fetch(url, {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json', ...(warehouseId ? { 'X-Warehouse': warehouseId } : {}) }),
    body: JSON.stringify(wrap ? { value } : value),
    credentials: 'include',
  })
  const text = await r.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error(`Сервер вернул не JSON (${r.status}): ${text.slice(0, 150)}`)
  }
  if (!r.ok) throw new Error(r.status === 403 ? 'В WMS выбран склад, к которому у вас нет доступа на сайте — данные не сохранены' : (data?.error || r.statusText || `HTTP ${r.status}`))
  return { ...data, warehouseId }
}

function _buildBodyForBrowser(options) {
  return {
    productId: null,
    parts: [],
    operationTypes: ['PICK_BY_LINE', 'PIECE_SELECTION_PICKING'],
    sourceCellId: null,
    targetCellId: null,
    sourceHandlingUnitBarcode: null,
    targetHandlingUnitBarcode: null,
    operationStartedAtFrom: null,
    operationStartedAtTo: null,
    operationCompletedAtFrom: options.operationCompletedAtFrom,
    operationCompletedAtTo: options.operationCompletedAtTo,
    executorId: null,
    pageNumber: options.pageNumber || 1,
    pageSize: options.pageSize || 2000,
  }
}

async function _fetchOnePageFromBrowser(token, body) {
  const r = await fetch(SAMOKAT_STOCKS_URL, {
    method: 'POST',
    headers: {
      ...wmsHeaders(token),
      'Content-Type': 'application/json',
      'X-Who': 'a3327d34-1f6b-46bb-9936-0306ec6c21ad',
    },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  const trimmed = (text || '').trim().toLowerCase()
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    throw new Error('WMS вернул HTML вместо JSON. Проверьте VPN или доступ.')
  }
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error('Ответ не JSON: ' + (text || '').slice(0, 150))
  }
  if (!r.ok) throw new Error(`API ${r.status}: ${data?.message || data?.error || r.statusText}`)
  const value = data?.value || data
  const items = Array.isArray(value?.items) ? value.items : []
  const total = value?.total ?? data?.totalElements ?? null
  return { items, total }
}

export async function fetchDataViaBrowser(token, options = {}) {
  const pageSize = Math.min(2000, Math.max(100, parseInt(options.pageSize, 10) || 2000))
  const first = await _fetchOnePageFromBrowser(token, _buildBodyForBrowser({ ...options, pageNumber: 1, pageSize }))
  let allItems = [...first.items]
  const total = first.total ?? allItems.length
  const totalPages = Math.ceil(total / pageSize)

  for (let p = 2; p <= totalPages; p++) {
    const next = await _fetchOnePageFromBrowser(token, _buildBodyForBrowser({ ...options, pageNumber: p, pageSize }))
    allItems = allItems.concat(next.items)
  }

  // Один запрос на весь фетч, а не один на каждый час — /api/save-fetched-data
  // (SaveFetchedData.dll) сам группирует items по московским (date,hour)
  // внутри одного запуска процесса. Раньше здесь был цикл по _groupItemsByHour
  // (как и в оригинале) — на каждый час уходил отдельный вызов, а значит и
  // отдельный запуск .NET-процесса (~0.5с фиксированных на старт рантайма,
  // не на объём данных); на дневную смену (9-21, до 12 часов) это давало
  // много лишних секунд ожидания без единой пользы — .NET-инструмент и так
  // умеет разложить один большой батч по часам сам.
  const saveRes = await postOwnBackend('/api/save-fetched-data', { items: allItems, total: allItems.length }, token)
  if (saveRes.ok !== true) throw new Error(saveRes.error || 'Ошибка сохранения')

  return {
    success: true,
    fetched: allItems.length,
    added: saveRes.added ?? 0,
    skipped: saveRes.skipped ?? 0,
    engine: saveRes.engine ?? null,
    timings: saveRes.timings ?? null,
    newEmployees: saveRes.newEmployees || [],
  }
}

async function _fetchPlacementPage(token, params) {
  const r = await fetch(`${PLACEMENT_TASKS_URL}?${params}`, { headers: wmsHeaders(token) })
  const text = await r.text()
  const trimmed = (text || '').trim().toLowerCase()
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    throw new Error('WMS вернул HTML вместо JSON. Проверьте VPN или вход.')
  }
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error('Ответ размещения не JSON: ' + (text || '').slice(0, 150))
  }
  if (!r.ok) throw new Error(`WMS placement ${r.status}: ${data?.message || data?.error || r.statusText}`)
  const value = data?.value || data
  return { items: Array.isArray(value?.items) ? value.items : [], total: value?.total ?? data?.totalElements ?? null }
}

export async function fetchPlacementViaBrowser(token, { dateFrom, dateTo, createdAtFrom, createdAtTo, pageSize = 500 } = {}) {
  const size = Math.min(500, Math.max(1, parseInt(pageSize, 10) || 500))
  const buildParams = pageNumber => {
    const p = new URLSearchParams()
    p.set('status', 'COMPLETED')
    if (dateFrom || createdAtFrom) p.set('dateFrom', dateFrom || createdAtFrom)
    if (dateTo || createdAtTo) p.set('dateTo', dateTo || createdAtTo)
    p.set('pageNumber', String(pageNumber))
    p.set('pageSize', String(size))
    return p
  }
  const first = await _fetchPlacementPage(token, buildParams(1))
  let allItems = [...first.items]
  const total = first.total ?? allItems.length
  const pages = Math.ceil(total / size)
  for (let page = 2; page <= pages; page++) {
    const next = await _fetchPlacementPage(token, buildParams(page))
    allItems = allItems.concat(next.items)
  }
  const saveRes = await postOwnBackend('/api/stats/placement/save', { items: allItems, total: allItems.length }, token)
  if (saveRes.ok !== true) throw new Error(saveRes.error || 'Ошибка сохранения размещения')
  return {
    success: true,
    fetched: allItems.length,
    added: saveRes.added ?? 0,
    skipped: saveRes.skipped ?? 0,
    newEmployees: saveRes.newEmployees || [],
  }
}

async function _fetchRemainsPage(token, params) {
  const r = await fetch(`${REMAINS_TASKS_URL}?${params}`, { headers: wmsHeaders(token) })
  const text = await r.text()
  const trimmed = (text || '').trim().toLowerCase()
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    throw new Error('WMS вернул HTML вместо JSON. Проверьте VPN или вход.')
  }
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error('Ответ объединения остатков не JSON: ' + (text || '').slice(0, 150))
  }
  if (!r.ok) throw new Error(`WMS remains ${r.status}: ${data?.message || data?.error || r.statusText}`)
  const value = data?.value || data
  return { items: Array.isArray(value?.items) ? value.items : [], total: value?.total ?? data?.totalElements ?? null }
}

export async function fetchRemainsViaBrowser(token, { dateFrom, dateTo, pageSize = 500 } = {}) {
  const size = Math.min(500, Math.max(1, parseInt(pageSize, 10) || 500))
  const buildParams = pageNumber => {
    const p = new URLSearchParams()
    p.set('status', 'COMPLETED')
    if (dateFrom) p.set('dateFrom', dateFrom)
    if (dateTo) p.set('dateTo', dateTo)
    p.set('pageNumber', String(pageNumber))
    p.set('pageSize', String(size))
    return p
  }
  const first = await _fetchRemainsPage(token, buildParams(1))
  let allItems = [...first.items]
  const total = first.total ?? allItems.length
  const pages = Math.ceil(total / size)
  for (let page = 2; page <= pages; page++) {
    const next = await _fetchRemainsPage(token, buildParams(page))
    allItems = allItems.concat(next.items)
  }
  const saveRes = await postOwnBackend('/api/stats/remains/save', { items: allItems, total: allItems.length }, token)
  if (saveRes.ok !== true) throw new Error(saveRes.error || 'Ошибка сохранения объединения остатков')
  return { success: true, fetched: allItems.length, added: saveRes.added ?? 0, skipped: saveRes.skipped ?? 0, newEmployees: saveRes.newEmployees || [] }
}

// Новые сотрудники из нескольких выгрузок (newEmployees: [{ executorId, fio }])
// одним списком без повторов по executorId. ФИО — как пришло из WMS.
export function mergeNewEmployees(...lists) {
  const byId = new Map()
  for (const e of lists.flat()) {
    if (!e?.executorId || !e.fio || byId.has(e.executorId)) continue
    byId.set(e.executorId, { executorId: e.executorId, fio: e.fio })
  }
  return [...byId.values()]
}

// Спуск, пополнение и размещение — из того же журнала stocks/changes, что и
// комплектация, одной выгрузкой на три типа; сохраняются отдельно от неё
// (/api/stats/stock-moves/save), бэкенд сам раскладывает по типам.
const STOCK_MOVE_TYPES = ['PIECE_SELECTION_HANDLING_UNIT_DESCENT', 'PIECE_SELECTION_PICKING_REPLENISHMENT', 'STORAGE_PLACEMENT']

// В бэкенд — только нужные поля: в ответе WMS на каждую строку ещё картинка,
// штрихкоды и сроки товара, запрос вышел бы в разы тяжелее.
function _slimStockMove(it) {
  return {
    id: it.id,
    operationType: it.operationType,
    product: { nomenclatureCode: it.product?.nomenclatureCode, name: it.product?.name, productId: it.product?.productId },
    sourceAddress: it.sourceAddress,
    targetAddress: it.targetAddress,
    operationStartedAt: it.operationStartedAt,
    operationCompletedAt: it.operationCompletedAt,
    responsibleUser: it.responsibleUser,
    targetQuantity: it.targetQuantity,
  }
}

export async function fetchStockMovesViaBrowser(token, { dateFrom, dateTo, pageSize = 2000 } = {}) {
  const size = Math.min(2000, Math.max(100, parseInt(pageSize, 10) || 2000))
  const body = pageNumber => ({
    ..._buildBodyForBrowser({ operationCompletedAtFrom: dateFrom, operationCompletedAtTo: dateTo, pageNumber, pageSize: size }),
    operationTypes: STOCK_MOVE_TYPES,
  })
  const first = await _fetchOnePageFromBrowser(token, body(1))
  let allItems = first.items.map(_slimStockMove)
  const total = first.total ?? allItems.length
  const pages = Math.ceil(total / size)
  for (let page = 2; page <= pages; page++) {
    const next = await _fetchOnePageFromBrowser(token, body(page))
    allItems = allItems.concat(next.items.map(_slimStockMove))
  }
  const saveRes = await postOwnBackend('/api/stats/stock-moves/save', { items: allItems, total: allItems.length }, token)
  if (saveRes.ok !== true) throw new Error(saveRes.error || 'Ошибка сохранения спуска/пополнения/размещения')
  return { success: true, fetched: allItems.length, added: saveRes.added ?? 0, skipped: saveRes.skipped ?? 0, newEmployees: saveRes.newEmployees || [] }
}

// Приёмка — порт fetchReceivingViaBrowser из оригинала (frontend/app api).
// Список принятых поставок за период лёгкий (SKU/штуки/вес/ЕО уже в нём), а
// приёмщика WMS отдаёт только отдельным запросом на каждую поставку — это и
// грузило WMS. Поэтому: запускается только вручную (Настройки → Система,
// admin/developer), и за приёмщиком ходим лишь по поставкам, которых ещё нет
// у нас в базе (/api/stats/receiving/known).
function _pickInboundAcceptedUser(responsibleUsers = []) {
  const accepted = responsibleUsers.find(u => u.type === 'ACCEPTANCE_COMPLETED')
    ?? responsibleUsers.find(u => u.type === 'ACCEPTANCE_STARTED')
  return accepted?.user || null
}

export async function fetchReceivingViaBrowser(token, { completedDateFrom, completedDateTo, onProgress } = {}) {
  const size = 100
  const base = {
    completedDateFrom,
    completedDateTo,
    statuses: ['COMPLETED_AS_PLANNED', 'COMPLETED_WITH_DISCREPANCY'],
    types: ['IMPORT', 'CROSSDOCK', 'STORAGE', 'STORAGE_DC'],
    pageSize: size,
    sortField: 'PLANNED_ARRIVAL_DATE',
    sortDirection: 'DESC',
  }
  const first = await getInboundTasks(token, { ...base, pageNumber: 1 })
  const total = first?.value?.total ?? 0
  let tasks = [...(first?.value?.items ?? [])]
  const pages = Math.ceil(total / size)
  for (let page = 2; page <= pages; page++) {
    const next = await getInboundTasks(token, { ...base, pageNumber: page })
    tasks = tasks.concat(next?.value?.items ?? [])
  }

  const known = await postOwnBackend('/api/stats/receiving/known', { ids: tasks.map(t => t.id) }, token, { wrap: false })
  const knownIds = new Set(known?.ids || [])
  const toEnrich = tasks.filter(t => !knownIds.has(t.id))
  onProgress?.({ total: tasks.length, known: knownIds.size, toEnrich: toEnrich.length, done: 0 })

  // Поставка без найденного приёмщика (WMS не вернул его или запрос упал)
  // раньше выбрасывалась целиком — и итог по поставкам расходился с WMS.
  // Теперь сохраняется без приёмщика (строка «—» в статистике); при
  // следующем обновлении её приёмщик будет запрошен снова.
  const enriched = []
  let noAcceptor = 0
  let done = 0
  const BATCH = 8
  for (let i = 0; i < toEnrich.length; i += BATCH) {
    const rows = await Promise.all(toEnrich.slice(i, i + BATCH).map(async task => {
      try {
        const res = await getInboundTaskResponsibleUsers(token, { taskType: task.type, id: task.id })
        const user = _pickInboundAcceptedUser(res?.value?.responsibleUsers ?? [])
        return user ? { ...task, responsibleUser: user } : { ...task, _noAcceptor: true }
      } catch {
        return { ...task, _noAcceptor: true }
      }
    }))
    for (const r of rows) {
      if (r._noAcceptor) noAcceptor++
      const { _noAcceptor, ...task } = r
      enriched.push(task)
    }
    done += rows.length
    onProgress?.({ total: tasks.length, known: knownIds.size, toEnrich: toEnrich.length, done })
  }

  let saveRes = { added: 0, skipped: 0 }
  if (enriched.length > 0) {
    saveRes = await postOwnBackend('/api/stats/receiving/save', { items: enriched, total: enriched.length }, token)
    if (saveRes.ok !== true) throw new Error(saveRes.error || 'Ошибка сохранения приёмки')
  }
  return {
    success: true,
    fetched: tasks.length,
    known: knownIds.size,
    requested: toEnrich.length,
    saved: enriched.length,
    noAcceptor,
    added: saveRes.added ?? 0,
    newEmployees: saveRes.newEmployees || [],
  }
}

// ─── Факт по графику поставок ───────────────────────────────────────────────
// Задания приёмки вокруг даты графика: плановое прибытие ±1 день и
// завершённые в смены этой даты (до 12:00 следующего дня). Объединение по id;
// сверка с графиком — по номеру заказа (orderNumber).
export async function fetchInboundAroundDate(token, date) {
  const day = d => new Date(`${d}T00:00:00+03:00`)
  const shift = (d, days) => new Date(day(d).getTime() + days * 86400000)
  const queries = [
    { dateFrom: shift(date, -1).toISOString(), dateTo: new Date(shift(date, 2).getTime() - 1).toISOString() },
    { completedDateFrom: day(date).toISOString(), completedDateTo: new Date(shift(date, 1).getTime() + 12 * 3600000).toISOString() },
  ]
  const byId = new Map()
  for (const q of queries) {
    let page = 1
    for (;;) {
      const res = await getInboundTasks(getStoredToken() || token, { ...q, pageNumber: page, pageSize: 100 })
      const items = res?.value?.items || []
      for (const it of items) byId.set(it.id, it)
      const total = res?.value?.total ?? items.length
      if (page * 100 >= total || !items.length) break
      page++
    }
  }
  return [...byId.values()]
}

// ─── Переводы ЕО в ЗГЗ (поиск потерянных ЕО) ───────────────────────────────
// stocks/changes, MOVE_TO_READY_ORDERS_ZONE: строка — товар в ЕО (ЕО одна и
// та же у источника и назначения), источник — ячейка КДК, назначение — ЗГЗ.
// За сутки — сотни тысяч строк: страницы по 2000, по 4 параллельно, строки
// сразу облегчаются (без картинок/сроков/остатков).
export async function fetchZgzMoves(token, { from, to, onProgress } = {}) {
  const size = 2000
  const body = pageNumber => ({
    ..._buildBodyForBrowser({ operationCompletedAtFrom: from, operationCompletedAtTo: to, pageNumber, pageSize: size }),
    operationTypes: ['MOVE_TO_READY_ORDERS_ZONE'],
  })
  const slim = it => ({
    id: it.id,
    hu: it.targetAddress?.handlingUnitBarcode || it.sourceAddress?.handlingUnitBarcode || '',
    sourceCell: it.sourceAddress?.cellAddress || '',
    targetCell: it.targetAddress?.cellAddress || '',
    productId: it.product?.productId || it.product?.nomenclatureCode || it.product?.name || '',
    name: it.product?.name || '',
    code: it.product?.nomenclatureCode || '',
    barcodes: it.product?.barcodes || [],
    qty: Math.max(0, (Number(it.targetQuantity?.newQuantity) || 0) - (Number(it.targetQuantity?.oldQuantity) || 0)) || 1,
    executorId: it.responsibleUser?.id || '',
    executor: [it.responsibleUser?.lastName, it.responsibleUser?.firstName, it.responsibleUser?.middleName].filter(Boolean).join(' '),
    completedAt: it.operationCompletedAt || null,
  })
  const first = await _fetchOnePageFromBrowser(token, body(1))
  let rows = first.items.map(slim)
  const total = first.total ?? rows.length
  const pages = Math.ceil(total / size)
  onProgress?.({ loaded: rows.length, total })
  const PARALLEL = 4
  for (let p = 2; p <= pages; p += PARALLEL) {
    const batch = Array.from({ length: Math.min(PARALLEL, pages - p + 1) }, (_, i) => p + i)
    // токен продлевается AuthContext'ом — берём свежий на каждую пачку
    const t = getStoredToken() || token
    const results = await Promise.all(batch.map(n => _fetchOnePageFromBrowser(t, body(n))))
    for (const r of results) rows = rows.concat(r.items.map(slim))
    onProgress?.({ loaded: rows.length, total })
  }
  return rows
}

// Загрузить переводы в ЗГЗ из WMS и сохранить на сервер (повторы строк
// отсекает сервер). Отправка частями — за сутки сотни тысяч строк, а лимит
// тела запроса у сервера 50 МБ.
export async function syncZgzFromWms(token, { from, to, onProgress } = {}) {
  const rows = await fetchZgzMoves(token, { from, to, onProgress: p => onProgress?.({ stage: 'wms', ...p }) })
  const CHUNK = 10000
  let added = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const res = await postOwnBackend('/api/zgz/save', { items: rows.slice(i, i + CHUNK) }, getStoredToken() || token, { wrap: false })
    if (res.ok !== true) throw new Error(res.error || 'Ошибка сохранения на сервер')
    added += res.added || 0
    onProgress?.({ stage: 'save', loaded: Math.min(i + CHUNK, rows.length), total: rows.length })
  }
  return { fetched: rows.length, added }
}

// ─── Ячейки зоны с ЦФЗ (topology/v2/cells/find) ─────────────────────────────
// У ячеек КДК storeName — магазин (ЦФЗ), под который в ячейке собирают заказы.
export async function fetchZoneCells(token, zoneId) {
  const size = 100
  const page = async pageNumber => {
    const r = await fetch(TOPOLOGY_CELLS_FIND_URL, {
      method: 'POST',
      headers: { ...wmsHeaders(token), 'Content-Type': 'application/json', 'X-Who': 'a3327d34-1f6b-46bb-9936-0306ec6c21ad' },
      body: JSON.stringify({
        filter: { cellAddressSearch: null, cellIds: [], zoneId, locationId: null, types: [], rows: [], sections: null, levels: [], numbers: null, statuses: [], operationTypes: [], withCategories: null, updatedAtFrom: null, updatedAtTo: null },
        pageNumber, pageSize: size, sortBy: 'CELL_ADDRESS', sortDirection: null,
      }),
    })
    if (!r.ok) throw new Error(`WMS cells/find ${r.status}`)
    const data = await r.json()
    return { items: data?.value?.items || [], total: data?.value?.total ?? 0 }
  }
  const first = await page(1)
  let items = [...first.items]
  for (let p = 2; p <= Math.ceil(first.total / size); p++) items = items.concat((await page(p)).items)
  return {
    zoneName: items[0]?.zone?.name || '',
    cells: items.map(c => ({ address: c.address, cellId: c.id || '', storeName: c.storeName || '' })),
  }
}

// ─── Веса товаров из WMS ────────────────────────────────────────────────────
// Вес единицы — stocks/overview/{productId} → product.measurements.weight (г).
// Нет productId — сначала products/search по артикулу.

async function findWmsProductId(token, code) {
  const r = await fetch(PRODUCTS_SEARCH_URL, {
    method: 'POST',
    headers: { ...wmsHeaders(token), 'Content-Type': 'application/json', 'X-Who': 'a3327d34-1f6b-46bb-9936-0306ec6c21ad' },
    body: JSON.stringify({ productFilter: { type: 'PRODUCT_NOMENCLATURE_CODE', nomenclatureCode: code }, pageSize: 30, pageNumber: 1 }),
  })
  if (!r.ok) throw new Error(`WMS products/search ${r.status}`)
  const data = await r.json()
  const list = data?.value?.data || []
  return (list.find(p => p.nomenclatureCode === code) || list[0])?.id || null
}

// ─── Поиск ЕО по ШК товара ──────────────────────────────────────────────────
// ШК → товары (products/search, PRODUCT_BARCODE) → остатки товара по ячейкам
// и ЕО (stocks/v2/details). Ворота — ячейки G<номер> («Ворота 147»).
const STOCKS_DETAILS_URL = 'https://api.samokat.ru/wmsops-wwh/stocks/v2/details'

export async function findProductsByBarcode(token, barcode) {
  const r = await fetch(PRODUCTS_SEARCH_URL, {
    method: 'POST',
    headers: { ...wmsHeaders(token), 'Content-Type': 'application/json', 'X-Who': 'a3327d34-1f6b-46bb-9936-0306ec6c21ad' },
    body: JSON.stringify({ productFilter: { type: 'PRODUCT_BARCODE', barcode }, pageSize: 30, pageNumber: 1 }),
  })
  if (!r.ok) throw new Error(`WMS products/search ${r.status}`)
  const data = await r.json()
  return (data?.value?.data || []).map(p => ({ id: p.id, name: p.productName || '', code: p.nomenclatureCode || '', imageUrl: p.imageUrl || '' }))
}

export async function fetchProductStock(token, productId) {
  const size = 100
  const out = []
  for (let pageNumber = 1; pageNumber <= 50; pageNumber++) {
    const r = await fetch(STOCKS_DETAILS_URL, {
      method: 'POST',
      headers: { ...wmsHeaders(token), 'Content-Type': 'application/json', 'X-Who': 'a3327d34-1f6b-46bb-9936-0306ec6c21ad' },
      body: JSON.stringify({
        productId, parts: null, statuses: null, cellId: null, handlingUnitBarcode: null, zoneIds: null, locationIds: null,
        rows: null, sections: null, levels: null, owner: null, sortByQuantity: null, pageNumber, pageSize: size,
      }),
    })
    if (!r.ok) throw new Error(`WMS stocks/v2/details ${r.status}`)
    const data = await r.json()
    const items = data?.value?.items || []
    out.push(...items)
    if (items.length < size || out.length >= (data?.value?.total ?? 0)) break
  }
  return out.map(s => ({
    cell: s.address?.cellAddress || '',
    eo: s.address?.handlingUnitBarcode || '',
    zone: s.location?.zoneName || '',
    location: s.location?.locationName || '',
    status: s.status || '',
    quantity: Number(s.quantity) || 0,
    productionDate: s.part?.productionDate || null,
    bestBeforeDate: s.part?.bestBeforeDate || null,
  }))
}

export async function fetchWmsProductWeight(token, { code, productId }) {
  const id = productId || await findWmsProductId(token, code)
  if (!id) return { productId: null, grams: 0 }
  const data = await samokatGet(token, `${STOCKS_OVERVIEW_URL}/${id}`, '')
  const product = data?.value?.product || {}
  return {
    productId: id,
    grams: Number(product.measurements?.weight) || 0,
    name: product.name || '',
    // штучные штрихкоды и упаковки (коробка: штрихкод + штук в ней) — для «Поиска потеряшек»
    barcodes: product.barcodes || [],
    packages: (data?.value?.packages || []).map(pk => ({ barcode: pk.barcode, qty: Number(pk.quantityInPackage) || 0 })).filter(pk => pk.barcode && pk.qty > 1),
  }
}

// Дозапросить вес у WMS по списку [{ code, name, productId }] и сохранить
// найденное в справочник (пачками — прогресс не теряется при обрыве).
// Токен — свежий на каждую пачку (живёт ~5 минут, AuthContext продлевает).
export async function fillWeightsFromWms(items, { onProgress, shouldStop } = {}) {
  const BATCH = 5
  const SAVE_EVERY = 50
  let pending = []
  let checked = 0, saved = 0
  const notFound = []
  const flush = async () => {
    if (!pending.length) return
    const res = await saveWmsWeights(pending)
    saved += res?.saved ?? pending.length
    pending = []
  }
  for (let i = 0; i < items.length; i += BATCH) {
    if (shouldStop?.()) break
    const token = getStoredToken()
    if (!token) throw new Error('WMS-токен истёк — войдите паролем от WMS')
    const results = await Promise.all(items.slice(i, i + BATCH).map(async it => {
      try { return { it, res: await fetchWmsProductWeight(token, it) } } catch (err) { return { it, err } }
    }))
    for (const { it, res, err } of results) {
      checked++
      const entry = res && { article: it.code, grams: res.grams, productId: res.productId, name: res.name || it.name, barcodes: res.barcodes, packages: res.packages }
      if (res?.grams > 0) pending.push(entry)
      else {
        // веса нет, но штрихкоды/упаковки пригодятся поиску — сохраняем и их
        if (res?.barcodes?.length || res?.packages?.length) pending.push(entry)
        notFound.push({ ...it, reason: err ? err.message : res?.productId ? 'в WMS не указан вес' : 'товар не найден в WMS' })
      }
    }
    if (pending.length >= SAVE_EVERY) await flush()
    onProgress?.({ checked, total: items.length, found: checked - notFound.length, notFound: notFound.length })
  }
  await flush()
  return { checked, saved, notFound }
}

// ─── Отчёты / анализ / поставки ─────────────────────────────────────────────
// Общая библиотека WMS-запросов, шарится между AnalysisPage/HourlyReport/
// SuppliesPage/EoSearchPage/SupplyDetailPage.

async function samokatGet(token, url, params) {
  const r = await fetch(`${url}?${params}`, {
    headers: { ...wmsHeaders(token), 'X-Who': 'a3327d34-1f6b-46bb-9936-0306ec6c21ad' },
  })
  const text = await r.text()
  const trimmed = (text || '').trim().toLowerCase()
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    throw new Error('Нет доступа к API. Проверьте VPN или войдите заново.')
  }
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error('Ответ не JSON: ' + (text || '').slice(0, 150))
  }
  if (!r.ok) throw new Error(`API ${r.status}: ${data?.message || data?.error || r.statusText}`)
  return data
}

/** Статистика отборки (КДК + Хранение). createdAtFrom/To — ISO UTC. */
export async function getReportMonitoringStats(token, createdAtFrom, createdAtTo) {
  return samokatGet(token, MONITORING_STATS_URL, new URLSearchParams({ createdAtFrom, createdAtTo }))
}

/**
 * Поставки — список заданий на приёмку с пагинацией и фильтрами.
 * params: { pageNumber, pageSize, sortField, sortDirection, dateFrom, dateTo, completedDateFrom, completedDateTo, statuses, types, temperatureModes }
 */
export async function getInboundTasks(token, {
  pageNumber = 1,
  pageSize = 30,
  sortField = 'PLANNED_ARRIVAL_DATE',
  sortDirection = 'DESC',
  dateFrom,
  dateTo,
  completedDateFrom,
  completedDateTo,
  statuses,
  types,
  temperatureModes,
} = {}) {
  const params = new URLSearchParams()
  params.set('inboundSortFieldName', sortField)
  params.set('sortDirection', sortDirection)
  params.set('pageNumber', String(pageNumber))
  params.set('pageSize', String(pageSize))
  if (dateFrom) params.set('plannedArrivalDateFrom', dateFrom)
  if (dateTo) params.set('plannedArrivalDateTo', dateTo)
  if (completedDateFrom) params.set('completedAtDateFrom', completedDateFrom)
  if (completedDateTo) params.set('completedAtDateTo', completedDateTo)
  if (statuses) for (const s of [].concat(statuses)) params.append('status', s)
  if (types) for (const t of [].concat(types)) params.append('type', t)
  if (temperatureModes) for (const m of [].concat(temperatureModes)) params.append('temperatureMode', m)
  return samokatGet(token, INBOUND_TASKS_URL, params)
}

/** Приёмка — задания в процессе (AWAITING_GATE + AWAITING_ACCEPTANCE + ACCEPTANCE_IN_PROGRESS). Нам нужен только value.total. */
export async function getReportInboundInProgress(token, { types }) {
  const params = new URLSearchParams()
  params.append('status', 'AWAITING_GATE')
  params.append('status', 'AWAITING_ACCEPTANCE')
  params.append('status', 'ACCEPTANCE_IN_PROGRESS')
  for (const t of [].concat(types)) params.append('type', t)
  params.append('temperatureMode', 'MEDIUM_COLD')
  params.append('temperatureMode', 'ORDINARY')
  params.set('inboundSortFieldName', 'PLANNED_ARRIVAL_DATE')
  params.set('sortDirection', 'DESC')
  params.set('pageNumber', '1')
  params.set('pageSize', '1')
  return samokatGet(token, INBOUND_TASKS_URL, params)
}

/** Приёмка — принятые задания (COMPLETED_AS_PLANNED + COMPLETED_WITH_DISCREPANCY). Нам нужен только value.total. */
export async function getReportInboundCompleted(token, { types, completedAtDateFrom, completedAtDateTo }) {
  const params = new URLSearchParams()
  params.append('status', 'COMPLETED_AS_PLANNED')
  params.append('status', 'COMPLETED_WITH_DISCREPANCY')
  params.set('completedAtDateFrom', completedAtDateFrom)
  params.set('completedAtDateTo', completedAtDateTo)
  for (const t of [].concat(types)) params.append('type', t)
  params.append('temperatureMode', 'MEDIUM_COLD')
  params.append('temperatureMode', 'ORDINARY')
  params.set('inboundSortFieldName', 'PLANNED_ARRIVAL_DATE')
  params.set('sortDirection', 'DESC')
  params.set('pageNumber', '1')
  params.set('pageSize', '1')
  return samokatGet(token, INBOUND_TASKS_URL, params)
}

/** Пополнение — выполненные спуски MOVE_DOWN за смену. */
export async function getReportMovementsCount(token, { dateFrom, dateTo }) {
  const params = new URLSearchParams()
  params.set('dateFrom', dateFrom)
  params.set('dateTo', dateTo)
  params.set('taskType', 'MOVE_DOWN')
  params.set('pageNumber', '1')
  params.set('pageSize', '1')
  return samokatGet(token, MOVEMENTS_URL, params)
}

/** Пополнение — остаток спусков MOVE_DOWN (CREATED + IN_PROGRESS) за смену. */
export async function getReportMovementsRest(token, { dateFrom, dateTo }) {
  const params = new URLSearchParams()
  params.set('dateFrom', dateFrom)
  params.set('dateTo', dateTo)
  params.append('status', 'CREATED')
  params.append('status', 'IN_PROGRESS')
  params.set('taskType', 'MOVE_DOWN')
  params.set('pageNumber', '1')
  params.set('pageSize', '1')
  return samokatGet(token, MOVEMENTS_URL, params)
}

/** Пополнение — выполненные перемещения MOVE_TO_PICKING за смену. */
export async function getReportMoveToPickingCount(token, { dateFrom, dateTo }) {
  const params = new URLSearchParams()
  params.set('dateFrom', dateFrom)
  params.set('dateTo', dateTo)
  params.set('taskType', 'MOVE_TO_PICKING')
  params.set('pageNumber', '1')
  params.set('pageSize', '1')
  return samokatGet(token, MOVEMENTS_URL, params)
}

/** Пополнение — остаток перемещений MOVE_TO_PICKING (CREATED + IN_PROGRESS) за смену. */
export async function getReportMoveToPickingRest(token, { dateFrom, dateTo }) {
  const params = new URLSearchParams()
  params.set('dateFrom', dateFrom)
  params.set('dateTo', dateTo)
  params.append('status', 'CREATED')
  params.append('status', 'IN_PROGRESS')
  params.set('taskType', 'MOVE_TO_PICKING')
  params.set('pageNumber', '1')
  params.set('pageSize', '1')
  return samokatGet(token, MOVEMENTS_URL, params)
}

export async function getInboundTaskResponsibleUsers(token, { taskType, id }) {
  const slug = INBOUND_TYPE_SLUG[taskType] || taskType.toLowerCase().replace(/_/g, '-')
  return wmsGet(`https://api.samokat.ru/wmsin-wwh/inbound/${slug}/tasks/${id}/responsible-users`, token)
}

export async function getInboundTaskDetail(token, { taskType, id }) {
  const slug = INBOUND_TYPE_SLUG[taskType] || taskType.toLowerCase().replace(/_/g, '-')
  return wmsGet(`https://api.samokat.ru/wmsin-wwh/inbound/${slug}/tasks/${id}`, token)
}

/**
 * Изменения остатков для ЕО — возвращает остаток штук в ЕО.
 * Берём последнюю запись (pageSize=1): sourceQuantity.newQuantity = текущий остаток.
 * Если записей нет (total=0) — ничего не снималось, возвращаем null (= полный остаток).
 */
export async function getEoRemaining(token, sourceHandlingUnitBarcode) {
  const { items, total } = await _fetchOnePageFromBrowser(token, {
    productId: null, parts: [], operationTypes: [],
    sourceCellId: null, targetCellId: null,
    sourceHandlingUnitBarcode, targetHandlingUnitBarcode: null,
    operationStartedAtFrom: null, operationStartedAtTo: null,
    operationCompletedAtFrom: null, operationCompletedAtTo: null,
    executorId: null, pageNumber: 1, pageSize: 1,
  })
  if (!total) return null
  return items[0]?.sourceQuantity?.newQuantity ?? null
}

// Кто комплектует из ЕО: последние до 500 операций, где ЕО — источник
// (новые сверху). picked — штук отобрано по этим операциям; pickers —
// сотрудники с числом отборов, последний сверху.
export async function getEoPicking(token, sourceHandlingUnitBarcode) {
  const { items, total } = await _fetchOnePageFromBrowser(token, {
    productId: null, parts: [], operationTypes: [],
    sourceCellId: null, targetCellId: null,
    sourceHandlingUnitBarcode, targetHandlingUnitBarcode: null,
    operationStartedAtFrom: null, operationStartedAtTo: null,
    operationCompletedAtFrom: null, operationCompletedAtTo: null,
    executorId: null, pageNumber: 1, pageSize: 500,
  })
  const sorted = [...items].sort((a, b) => new Date(b.operationCompletedAt || 0) - new Date(a.operationCompletedAt || 0))
  const byUser = new Map()
  let picked = 0
  for (const it of sorted) {
    const q = it.sourceQuantity
    picked += Math.max(0, (Number(q?.oldQuantity) || 0) - (Number(q?.newQuantity) || 0))
    const u = it.responsibleUser
    const key = u?.id || [u?.lastName, u?.firstName].join(' ')
    if (!u || !key.trim()) continue
    const cur = byUser.get(key) || { user: u, count: 0, lastAt: it.operationCompletedAt }
    cur.count++
    byUser.set(key, cur)
  }
  return {
    total: total ?? items.length,
    complete: items.length >= (total ?? items.length),
    picked,
    lastAt: sorted[0]?.operationCompletedAt || null,
    lastType: sorted[0]?.operationType || null,
    pickers: [...byUser.values()],
  }
}

export async function getEoChangeInfo(token, sourceHandlingUnitBarcode) {
  const { items, total } = await _fetchOnePageFromBrowser(token, {
    productId: null, parts: [], operationTypes: [],
    sourceCellId: null, targetCellId: null,
    sourceHandlingUnitBarcode, targetHandlingUnitBarcode: null,
    operationStartedAtFrom: null, operationStartedAtTo: null,
    operationCompletedAtFrom: null, operationCompletedAtTo: null,
    executorId: null, pageNumber: 1, pageSize: 1,
  })
  const item = items[0] || null
  return {
    total: total ?? items.length,
    item,
    remaining: item?.sourceQuantity?.newQuantity ?? null,
    completedAt: item?.operationCompletedAt || null,
    executor: item?.responsibleUser || null,
  }
}
