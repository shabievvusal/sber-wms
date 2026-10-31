// Приёмка и отчёты: задания приёмки, факт по графику поставок, перемещения, остаток ЕО.
import { getStoredToken, samokatGet, wmsGet } from './core.js'
import { _fetchOnePageFromBrowser } from './stockChanges.js'

const MONITORING_STATS_URL = 'https://api.samokat.ru/wmsops-wwh/activity-monitor/selection/stats'

const INBOUND_TASKS_URL = 'https://api.samokat.ru/wmsin-wwh/inbound/tasks'

const MOVEMENTS_URL = 'https://api-p01.samokat.ru/wmsout-wwh/movements/picking-refill/tasks'

// Тип поставки → сегмент адреса inbound/{slug}/tasks. «На хранение от РЦ» —
// storage-dc через дефис (так ходит сам WMS); с storage_dc запросы приёмщика
// и карточки таких поставок падали, и они выпадали из статистики приёмки.
const INBOUND_TYPE_SLUG = { CROSSDOCK: 'crossdock', IMPORT: 'import', STORAGE: 'storage', STORAGE_DC: 'storage-dc' }

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
