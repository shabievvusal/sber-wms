// Выгрузка статистики из WMS в свой бэкенд: комплектация, размещение, остатки, спуск/пополнение, приёмка.
import { _buildBodyForBrowser, _fetchOnePageFromBrowser } from './stockChanges.js'
import { postOwnBackend, wmsHeaders } from './core.js'
import { getInboundTaskResponsibleUsers, getInboundTasks } from './reports.js'

const PLACEMENT_TASKS_URL = 'https://api.samokat.ru/wmsin-wwh/placement/tasks'

const REMAINS_TASKS_URL = 'https://api.samokat.ru/wmsin-wwh/storage-zone-movements/consolidation/tasks'

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
