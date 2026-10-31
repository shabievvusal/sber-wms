// Комплектация: живой мониторинг, штучный отбор, раскладка КДК, последняя завершённая задача сотрудника.
import { samokatPost, wmsGet } from './core.js'
import { _fetchOnePageFromBrowser } from './stockChanges.js'

const LIVE_MONITOR_URL = 'https://api.samokat.ru/wmsops-wwh/activity-monitor/selection/handling-units-in-progress'

const PIECE_SELECTION_TASKS_URL = 'https://api-p01.samokat.ru/wmsout-wwh/picking-selection/tasks'

// Живой снимок операций в процессе (MonitorPage.jsx, KdkLayoutPage.jsx).
export async function getLiveMonitorViaBrowser(token) {
  return wmsGet(LIVE_MONITOR_URL, token)
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
