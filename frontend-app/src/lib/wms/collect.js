// Выгрузка статистики из WMS в свой бэкенд: комплектация, размещение, остатки, спуск/пополнение, приёмка.
import { _buildBodyForBrowser, _fetchOnePageFromBrowser, fetchAllStockChanges } from './stockChanges.js'
import { postOwnBackend, wmsHeaders } from './core.js'
import { getInboundTaskDetail, getInboundTaskResponsibleUsers, getInboundTasks } from './reports.js'

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
  // replace — выгрузка за полный период: сервер заменяет штуки суммой, а не берёт большее
  const saveRes = await postOwnBackend('/api/save-fetched-data', { items: allItems, total: allItems.length, replace: !!options.replace }, token)
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
// Список принятых поставок за период лёгкий (SKU/штуки/вес/ЕО уже в нём), но
// приёмщика в нём нет.
// С 07.11.2026 приёмщик сверяется по факту: по каждой новой поставке
// открывается её карточка (inbound/{тип}/tasks/{id}) — в ней все ЕО поставки
// с фактически принятыми штуками. Журнал приёмки WMS (stocks/changes,
// RECEIVING) за сутки грузится 1–2 запросами, у каждой его строки — ЕО, штуки
// и приёмщик (responsibleUser.id). Приёмщик поставки — тот, кто по журналу
// принял её ЕО; засчитывается, только если штуки журнала по этим ЕО равны
// факту карточки. Не сошлось, ЕО в журнале нет или карточка не открылась —
// как раньше, запрос responsible-users по этой поставке.
// Прежняя схема (до 07.11.2026): за приёмщиком — запрос responsible-users на
// каждую новую поставку; запускается только вручную (Настройки → Система,
// admin/developer), поставки, которые уже есть в базе
// (/api/stats/receiving/known), не запрашиваются.
function _pickInboundAcceptedUser(responsibleUsers = []) {
  const accepted = responsibleUsers.find(u => u.type === 'ACCEPTANCE_COMPLETED')
    ?? responsibleUsers.find(u => u.type === 'ACCEPTANCE_STARTED')
  return accepted?.user || null
}

// Карточка поставки → ЕО и факт: { hus: Map(ЕО → штук), pieces, sku }
function _inboundFact(detail) {
  const hus = new Map()
  let sku = 0
  for (const p of detail?.products ?? []) {
    if ((p.actualQuantity?.pieceProducts ?? 0) > 0) sku++
    for (const part of p.parts ?? []) {
      for (const hu of part.handlingUnits ?? []) {
        const q = Number(hu.actualQuantity?.pieceProducts) || 0
        if (hu.handlingUnitBarcode) hus.set(hu.handlingUnitBarcode, (hus.get(hu.handlingUnitBarcode) || 0) + q)
      }
    }
  }
  let pieces = 0
  for (const q of hus.values()) pieces += q
  return { hus, pieces, sku }
}

// Журнал приёмки → ЕО → [{ user, qty }]
function _journalByHu(lines) {
  const map = new Map()
  for (const l of lines) {
    const hu = l.targetAddress?.handlingUnitBarcode
    const user = l.responsibleUser
    if (!hu || !user?.id) continue
    const t = l.targetQuantity
    const qty = t ? (Number(t.newQuantity) || 0) - (Number(t.oldQuantity) || 0) : 0
    const list = map.get(hu) || []
    list.push({ user, qty })
    map.set(hu, list)
  }
  return map
}

// Сверка поставки с журналом: { user } — приёмщик подтверждён штуками,
// { reason } — почему нет. Несколько приёмщиков на одной поставке — тот, кто
// принял больше штук.
function _matchAcceptor(fact, byHu) {
  const perUser = new Map()
  let journalPieces = 0
  for (const hu of fact.hus.keys()) {
    for (const { user, qty } of byHu.get(hu) ?? []) {
      journalPieces += qty
      const cur = perUser.get(user.id) || { user, qty: 0 }
      cur.qty += qty
      perUser.set(user.id, cur)
    }
  }
  if (!perUser.size) return { reason: 'noJournal' }
  if (journalPieces !== fact.pieces) return { reason: 'mismatch' }
  const top = [...perUser.values()].sort((a, b) => b.qty - a.qty)[0]
  return { user: top.user, several: perUser.size > 1 }
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

  const stat = { byJournal: 0, mismatch: 0, noJournal: 0, noDetail: 0, several: 0, requested: 0, noAcceptor: 0 }
  const report = done => onProgress?.({ total: tasks.length, known: knownIds.size, toEnrich: toEnrich.length, done, ...stat })

  // Журнал приёмки за период, с запасом в час до начала — строки журнала
  // датированы завершением приёмки, как и поставка, запас — для надёжности.
  let byHu = new Map()
  let journalLines = 0
  if (toEnrich.length > 0) {
    onProgress?.({ total: tasks.length, known: knownIds.size, toEnrich: toEnrich.length, done: 0, stage: 'journal' })
    const from = new Date(Date.parse(completedDateFrom) - 60 * 60 * 1000).toISOString()
    const lines = await fetchAllStockChanges(token, { operationTypes: ['RECEIVING'], from, to: completedDateTo })
    journalLines = lines.length
    byHu = _journalByHu(lines)
  }

  // Поставка без найденного приёмщика сохраняется без него (строка «—» в
  // статистике); при следующем обновлении её приёмщик будет запрошен снова.
  const enriched = []
  let done = 0
  const BATCH = 8
  for (let i = 0; i < toEnrich.length; i += BATCH) {
    const rows = await Promise.all(toEnrich.slice(i, i + BATCH).map(async task => {
      let fact = null
      try {
        const detail = await getInboundTaskDetail(token, { taskType: task.type, id: task.id })
        fact = _inboundFact(detail?.value)
      } catch { /* карточка не открылась — приёмщик запросом */ }
      // фактическое число SKU (в списке поставок — только плановое)
      const withFact = fact ? { ...task, actualSkuCount: fact.sku } : task
      const m = fact ? _matchAcceptor(fact, byHu) : { reason: 'noDetail' }
      if (m.user) return { task: { ...withFact, responsibleUser: m.user }, via: 'journal', several: m.several }
      try {
        const res = await getInboundTaskResponsibleUsers(token, { taskType: task.type, id: task.id })
        const user = _pickInboundAcceptedUser(res?.value?.responsibleUsers ?? [])
        return { task: user ? { ...withFact, responsibleUser: user } : withFact, via: 'request', reason: m.reason, noAcceptor: !user }
      } catch {
        return { task: withFact, via: 'request', reason: m.reason, noAcceptor: true }
      }
    }))
    for (const r of rows) {
      enriched.push(r.task)
      if (r.via === 'journal') { stat.byJournal++; if (r.several) stat.several++ }
      else { stat.requested++; stat[r.reason]++; if (r.noAcceptor) stat.noAcceptor++ }
    }
    done += rows.length
    report(done)
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
    journalLines,
    ...stat,
    saved: enriched.length,
    added: saveRes.added ?? 0,
    newEmployees: saveRes.newEmployees || [],
  }
}


