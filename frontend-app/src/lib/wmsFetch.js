// Единственное место в проекте, где JS обязан работать в браузере: получение
// данных из wwh.samokat.ru требует токена ТЕКУЩЕЙ сессии пользователя — сервер
// сходить туда сам не может. Портировано как есть из
// ../../zlp-main-main/frontend/app/src/api/index.js (fetchRkFromWms), без
// логики уровня приложения — только сеть.

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
const INBOUND_TYPE_SLUG = { CROSSDOCK: 'crossdock', IMPORT: 'import', STORAGE: 'storage', STORAGE_DC: 'storage_dc' }

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

  const r = await fetch('/api/rk/import-bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

async function postOwnBackend(url, value) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
    credentials: 'include',
  })
  const text = await r.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error(`Сервер вернул не JSON (${r.status}): ${text.slice(0, 150)}`)
  }
  if (!r.ok) throw new Error(data?.error || r.statusText || `HTTP ${r.status}`)
  return data
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
  // умеет разложить один большой батч по часам сам. См. PLAN.md.
  const saveRes = await postOwnBackend('/api/save-fetched-data', { items: allItems, total: allItems.length })
  if (saveRes.ok !== true) throw new Error(saveRes.error || 'Ошибка сохранения')

  return {
    success: true,
    fetched: allItems.length,
    added: saveRes.added ?? 0,
    skipped: saveRes.skipped ?? 0,
    engine: saveRes.engine ?? null,
    dotnetError: saveRes.dotnetError ?? null,
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
  const saveRes = await postOwnBackend('/api/stats/placement/save', { items: allItems, total: allItems.length })
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
  const saveRes = await postOwnBackend('/api/stats/remains/save', { items: allItems, total: allItems.length })
  if (saveRes.ok !== true) throw new Error(saveRes.error || 'Ошибка сохранения объединения остатков')
  return { success: true, fetched: allItems.length, added: saveRes.added ?? 0, skipped: saveRes.skipped ?? 0, newEmployees: saveRes.newEmployees || [] }
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
  const slug = INBOUND_TYPE_SLUG[taskType] || taskType.toLowerCase().replace('_', '-')
  return wmsGet(`https://api.samokat.ru/wmsin-wwh/inbound/${slug}/tasks/${id}/responsible-users`, token)
}

export async function getInboundTaskDetail(token, { taskType, id }) {
  const slug = INBOUND_TYPE_SLUG[taskType] || taskType.toLowerCase().replace('_', '-')
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
