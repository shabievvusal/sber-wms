// API-слой сайта: запросы к своему бэкенду (node и dotnet за Caddy; в разработке — vite.config.js proxy).
import { isEmbedded } from '@/lib/embed'
import { getWarehouseId } from '@/lib/warehouse'

const credentials = 'include'
// во встроенном в WMS режиме сервер ставит cookie входа для iframe (см. lib/embed.js)
const embedHeaders = isEmbedded ? { 'X-Embed': '1' } : {}

/** Заголовки каждого запроса к своему серверу: встроенный режим + выбранный
 *  склад (сервер отдаёт данные только этого склада, см. lib/warehouse.js). */
export function apiHeaders(extra, { noWarehouse = false } = {}) {
  const wh = noWarehouse ? null : getWarehouseId()
  return { ...embedHeaders, ...(wh ? { 'X-Warehouse': wh } : {}), ...(extra || {}) }
}

async function req(url, { noWarehouse, ...opts } = {}) {
  const r = await fetch(url, { credentials, ...opts, headers: apiHeaders(opts.headers, { noWarehouse }) })
  const text = await r.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error(`Сервер вернул не JSON (${r.status}): ${text.slice(0, 150)}`)
  }
  if (!r.ok) throw new Error(data?.error || r.statusText || `HTTP ${r.status}`)
  return data
}

// ─── Auth (сессия /api/vs/auth/*) ───────────────────────────────────────────

// вход и регистрация — без склада (сессии ещё нет, склад придёт в /me)
export async function loginVs(login, password) {
  return req('/api/vs/auth/login', {
    method: 'POST',
    noWarehouse: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, password }),
  })
}

export async function registerVs(data) {
  return req('/api/vs/auth/register', {
    method: 'POST',
    noWarehouse: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

/** Справочник складов (для формы регистрации — доступен без входа). */
export async function getWarehouses() {
  return req('/api/vs/auth/warehouses')
}

// Не через req() — 401 здесь означает «нет сессии», а не ошибку.
export async function getVsMe() {
  // с выбранным складом: роль и разделы у пользователя на каждом складе свои
  const r = await fetch('/api/vs/auth/me', { credentials, headers: apiHeaders() })
  if (!r.ok) return null
  return r.json()
}

// Сигнал «я на сайте» для «Был в сети» (см. lib/presence.js). Ошибки не важны:
// не дошёл один сигнал — дойдёт следующий через минуту.
export async function pingPresence() {
  try { await fetch('/api/vs/auth/ping', { method: 'POST', credentials }) } catch { /* сеть */ }
}

export async function logoutVs() {
  return req('/api/vs/auth/logout', { method: 'POST' })
}

// Прямой браузерный вызов в api.samokat.ru (не через свой бэкенд — тот же
// приём, что и в оригинале): именно этот WMS access/refresh-токен потом
// используется браузерными fetch'ами (wmsFetch.js) для скачивания реальных
// данных из WMS, серверный путь их не достаёт.
export async function refreshSamokatToken(refreshToken) {
  const r = await fetch('https://api.samokat.ru/wmsin-wwh/auth/refresh', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
  if (!r.ok) throw new Error(`Ошибка обновления токена: ${r.status}`)
  return r.json()
}

export async function getRkRoutes({ q, dateFrom, dateTo, receivedDateFrom, receivedDateTo, status } = {}) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (dateFrom) params.set('dateFrom', dateFrom)
  if (dateTo) params.set('dateTo', dateTo)
  if (receivedDateFrom) params.set('receivedDateFrom', receivedDateFrom)
  if (receivedDateTo) params.set('receivedDateTo', receivedDateTo)
  if (status) params.set('status', status)
  return req(`/api/rk/routes?${params}`)
}

export async function getDateSummaryFull(dateStr, { shift, idleThresholdMinutes } = {}) {
  const params = new URLSearchParams()
  if (shift) params.set('shift', shift)
  if (idleThresholdMinutes != null) params.set('idleThresholdMinutes', idleThresholdMinutes)
  return req(`/api/date/${dateStr}/summary?${params}`, { cache: 'no-store' })
}

export async function confirmRkShipment(routeId) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/confirm-ship`, { method: 'POST' })
}

export async function confirmRkReceiving(routeId) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/confirm-receive`, { method: 'POST' })
}

export async function deleteRkRoutesBulk(ids) {
  return req('/api/rk/routes/bulk', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
}

export async function getRkDrivers(q) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  return req(`/api/rk/drivers?${params}`)
}

export async function getRkCfz(q) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  return req(`/api/rk/cfz?${params}`)
}

export async function updateRkDriver(routeId, payload) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/driver`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function updateRkShipment(routeId, payload) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/ship`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function updateRkReceiving(routeId, payload) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/receive`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function deleteRkRoutesByDateRange(dateFrom, dateTo) {
  const params = new URLSearchParams({ dateFrom, dateTo })
  return req(`/api/rk/routes?${params}`, { method: 'DELETE' })
}

// fetchRkFromWms — намеренно НЕ реализуем здесь: требует настоящий токен браузерной
// сессии в wwh.samokat.ru.
// FetchModal ниже честно показывает это ограничение, а не притворяется, что скачал данные.

// ─── Приёмка (кио­ск отгрузки/приёмки РК) ───────────────────────────────────
// searchRkRoutes/submitRkShipment/submitRkReceiving — POST-эндпоинты кладовщика
// (без сессии), не путать с updateRkShipment/updateRkReceiving выше (PUT,
// редактирование администратором из ShipmentsPage — это два разных реальных
// роута на бэкенде).

// `days` — окно в N последних календарных дней (сегодня + предыдущие).
// Шлёт только «Список ЕО» и только для списка по умолчанию: у него нет
// `mode`, который у отгрузки/приёмки сам собой оставляет незакрытые
// маршруты, поэтому без окна отдавались ВСЕ маршруты за всю историю.
export async function searchRkRoutes({ mode, q, days } = {}) {
  const params = new URLSearchParams()
  if (mode) params.set('mode', mode)
  if (q) params.set('q', q)
  if (days) params.set('days', days)
  return req(`/api/rk/routes-search?${params}`)
}

export async function getDriverRokhlyaDebt(name) {
  const params = new URLSearchParams({ name })
  return req(`/api/rk/driver-rokhlya-debt?${params}`)
}

export async function getRkRoute(routeId) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}`)
}

export async function getRouteEos(routeId) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/eos`)
}

export async function submitRkShipment(routeId, payload) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/ship`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function submitRkReceiving(routeId, payload) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/receive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

// Фото сжимаются в браузере (до 1280 px) — на сервер уходят сотни КБ, а не
// мегабайты с камеры телефона; dotnet только нормализует и делает превью.
export async function uploadRkPhotos(files) {
  const { compressImage } = await import('@/lib/compressImage')
  const form = new FormData()
  for (const f of files) form.append('photos', await compressImage(f))
  const r = await fetch('/api/rk/photos', { method: 'POST', credentials, headers: apiHeaders(), body: form })
  const data = await r.json().catch(() => null)
  if (!r.ok) throw new Error(data?.error || 'Ошибка загрузки фото')
  return data
}

// Маршруты, чьи ЕО имеет смысл обновить фоном (последние `days` дней) —
// только метаданные, без самих ЕО. Дёргает устройство с включённым
// автообновлением (eoAutoRefresh.jsx), а не экран кладовщика.
export async function getEoRefreshTargets(days, { warehouseId } = {}) {
  const params = new URLSearchParams()
  if (days) params.set('days', days)
  return req(`/api/rk/eo-refresh-targets?${params}`, warehouseId ? { headers: { 'X-Warehouse': warehouseId } } : {})
}

// Сохранение ЕО, полученных браузером напрямую из WMS (fetchRouteFromWMS в
// wmsFetch.js) — единственный путь их обновления. Ручной запрос «сходи в WMS
// за меня» (requestEoRefresh + очередь на бэкенде) убран 2026-09-06: списки
// обновляет фоном устройство с автообновлением (lib/eoAutoRefresh.jsx).
export async function saveRouteEosRefresh(routeId, wmsData, { warehouseId } = {}) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/eos/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(warehouseId ? { 'X-Warehouse': warehouseId } : {}) },
    body: JSON.stringify(wmsData),
  })
}

// ─── Настройки: пользователи/роли/заявки ────────────────────────────────────

export async function getVsAdminUsers() {
  return req('/api/vs/admin/users')
}

export async function putVsAdminUser(login, payload) {
  return req('/api/vs/admin/users', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, ...payload }),
  })
}

export async function deleteVsAdminUser(login) {
  return req(`/api/vs/admin/users/${encodeURIComponent(login)}`, { method: 'DELETE' })
}

export async function getVsAdminRoles() {
  return req('/api/vs/admin/roles')
}

export async function addVsAdminRole(key, label, modules) {
  return req('/api/vs/admin/roles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, label, modules }),
  })
}

export async function updateVsAdminRole(key, label, modules) {
  return req(`/api/vs/admin/roles/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, modules }),
  })
}

export async function deleteVsAdminRole(key) {
  return req(`/api/vs/admin/roles/${encodeURIComponent(key)}`, { method: 'DELETE' })
}

export async function getVsAdminPending() {
  return req('/api/vs/admin/pending')
}

export async function approveVsPending(phone, role, modules) {
  return req('/api/vs/admin/pending/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, role, modules }),
  })
}

export async function rejectVsPending(phone) {
  return req(`/api/vs/admin/pending/${encodeURIComponent(phone)}`, { method: 'DELETE' })
}

// ─── Настройки: автообновление / ТСД / веса товаров ────────────────────────

export async function getAutoFetchSettings() {
  return req('/api/vs/auto-fetch-settings')
}

export async function updateAutoFetchSettings(settings) {
  return req('/api/vs/admin/auto-fetch-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings || {}),
  })
}

export async function getTsdSettings() {
  return req('/api/tsd-settings')
}

export async function updateTsdSettings(totalCount) {
  return req('/api/tsd-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ totalCount }),
  })
}

// ─── Выдача ТСД (терминалов сбора данных) — кио­ск-сканирование ────────────
// Все три эндпоинта требуют USE_PG=true на бэкенде (backend/tsd-pg.js) — без
// поднятого Postgres сервер отвечает 503.

export async function getTsdAssignments() {
  return req('/api/tsd-assignments')
}

export async function assignTsd({ executorId, fio, company, tsd }) {
  return req('/api/tsd-assignments/assign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ executorId, fio, company, tsd }),
  })
}

// Журнал выдачи/приёма — те же строки tsd_assignments, но БЕЗ фильтра
// returned_at IS NULL: строка попадает в выборку, если в диапазон [from, to]
// попало хотя бы одно её событие (выдача или возврат), см. TsdService.
export async function getTsdHistory({ from, to, limit } = {}) {
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  if (limit) params.set('limit', String(limit))
  const qs = params.toString()
  return req(`/api/tsd-assignments/history${qs ? `?${qs}` : ''}`)
}

export async function returnTsdByBarcode({ tsd, returnedByExecutorId, returnedByFio, returnedByCompany }) {
  return req('/api/tsd-assignments/return-tsd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tsd, returnedByExecutorId, returnedByFio, returnedByCompany }),
  })
}

// Сотрудники без executorId (не встречаются в статистике WMS) — заводятся
// вручную в Настройках исключительно для выдачи ТСД, не пересекаются с
// api.getEmployees()/эндпоинтом /api/employees (та таблица требует executorId
// и участвует в статистике/мониторинге, эта — нет).

export async function getTsdManualEmployees() {
  return req('/api/tsd/manual-employees')
}

export async function addTsdManualEmployee(fio, company) {
  return req('/api/tsd/manual-employees', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fio, company }),
  })
}

export async function updateTsdManualEmployee(id, fio, company) {
  return req(`/api/tsd/manual-employees/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fio, company }),
  })
}

export async function deleteTsdManualEmployee(id) {
  return req(`/api/tsd/manual-employees/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function getProductWeightsInfo() {
  return req('/api/vs/admin/product-weights/info')
}

export async function uploadProductWeightsExcel(file) {
  const fd = new FormData()
  fd.append('file', file)
  const r = await fetch('/api/vs/admin/product-weights/upload', { method: 'POST', credentials: 'include', body: fd })
  const data = await r.json()
  if (!r.ok) throw new Error(data.error || 'Ошибка загрузки')
  return data
}

// График поставок (supply-plans-pg.js на Node)
export async function uploadSupplyPlans(file) {
  const fd = new FormData()
  fd.append('file', file)
  const r = await fetch('/api/supply-plans/upload', { method: 'POST', credentials: 'include', headers: apiHeaders(), body: fd })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || 'Ошибка загрузки')
  return data
}
export async function getSupplyPlanDates() {
  return req('/api/supply-plans/dates')
}
export async function getSupplyPlan(date) {
  return req(`/api/supply-plans?date=${date}`)
}
export async function getKdkHistory(days = 120) {
  return req(`/api/supply-plans/kdk-history?days=${days}`)
}
// сверка дня с WMS (заказы графика + вне графика) — заменяет прежнюю за дату
export async function saveSupplyFacts(date, rows) {
  return req('/api/supply-plans/facts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, rows }) })
}
// план + сохранённый факт + итоги накопительного отчёта за период
export async function getSupplyRange(from, to) {
  return req(`/api/supply-plans/range?from=${from}&to=${to}`)
}

export async function deleteProductWeightsExcel() {
  return req('/api/vs/admin/product-weights', { method: 'DELETE' })
}

// Товары без веса в справочнике (комплектация + спуск/пополнение/размещение
// за последние days дней) — для дозапроса веса из WMS.
export async function getMissingWeightProducts(days = 120) {
  return req(`/api/product-weights/missing?days=${days}`)
}

// Сохранить веса, полученные из WMS: [{ article, grams, productId, name }].
export async function saveWmsWeights(items) {
  return req('/api/vs/admin/product-weights/wms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  })
}

// ─── Отчёты: объединение остатков ────────────────────────────────────────────

export async function uploadStockConsolidationReport(tasksCsvFile, stockXlsxFile, temperature) {
  const fd = new FormData()
  fd.append('tasksCsv', tasksCsvFile)
  fd.append('stockXlsx', stockXlsxFile)
  fd.append('temperature', temperature)
  const r = await fetch('/api/reports/stock-consolidation', { method: 'POST', credentials: 'include', body: fd })
  const data = await r.json()
  if (!r.ok) throw new Error(data.error || 'Ошибка загрузки')
  return data
}

// ─── Настройки: удаление данных за смену (admin/developer) ──────────────────

export async function getShiftDataCount(date, shift) {
  return req(`/api/stats/shift-data/count?date=${encodeURIComponent(date)}&shift=${encodeURIComponent(shift)}`)
}

export async function deleteShiftData(date, shift) {
  return req('/api/stats/shift-data/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, shift }),
  })
}

// ─── Настройки: сотрудники ───────────────────────────────────────────────────

export async function getEmployees() {
  return req('/api/empl')
}

export async function saveEmplOne(fio, company, executorId = null, phone = '', password = '') {
  return req('/api/empl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fio: (fio || '').trim(),
      company: (company != null ? String(company) : '').trim(),
      executorId: executorId || undefined,
      phone: (phone != null ? String(phone) : '').trim(),
      password: (password != null ? String(password) : '').trim(),
    }),
  })
}

export async function saveEmployeesAll(employees) {
  return req('/api/employees', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employees }),
  })
}

export async function findUnregisteredEmployees() {
  return req('/api/empl/find-unregistered')
}

// ─── Статистика (главная страница) / План смены ────────────────────────────
// getMonthlyEmployees используется и здесь («За период», операция «Отбор»),
// и в ShiftPlanPage (тот же эндпоинт, тот же клиент — не задублирован).

export async function getMonthlyEmployees(dateFrom, dateTo, shift, zone) {
  const params = new URLSearchParams({ dateFrom, dateTo })
  if (shift) params.set('shift', shift)
  if (zone) params.set('zone', zone)
  return req(`/api/stats/monthly-employees?${params}`)
}

export async function getMonthlyCompany(year, month, shift) {
  const params = new URLSearchParams({ year, month })
  if (shift) params.set('shift', shift)
  return req(`/api/stats/monthly-company?${params}`)
}

function opDateSummary(path) {
  return async (dateStr, { shift, fromHour, toHour, completedFrom, completedTo } = {}) => {
    const params = new URLSearchParams()
    if (shift) params.set('shift', shift)
    if (fromHour != null) params.set('fromHour', fromHour)
    if (toHour != null) params.set('toHour', toHour)
    // интервал времени завершения (ISO) — сейчас только у приёмки
    if (completedFrom && completedTo) { params.set('completedFrom', completedFrom); params.set('completedTo', completedTo) }
    return req(`/api/date/${dateStr}/${path}/summary?${params}`)
  }
}
export const getPlacementDateSummary = opDateSummary('placement')
export const getReceivingDateSummary = opDateSummary('receiving')
export const getRemainsDateSummary = opDateSummary('remains')

// Ячейки и ЦФЗ (справочник по зонам из WMS: id ячейки, магазин)
export async function getCellStores() {
  return req('/api/cell-stores')
}
export async function syncCellStores(zoneId, zoneName, cells) {
  return req('/api/cell-stores/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zoneId, zoneName, cells }),
  })
}
export async function deleteCellStoreZone(zoneId) {
  return req('/api/cell-stores/delete-zone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zoneId }),
  })
}

// «Поиск потеряшек» — переводы ЕО в ЗГЗ на сервере
export async function getZgzMoves(from, to) {
  return req(`/api/zgz/moves?${new URLSearchParams({ from, to })}`)
}
export async function getZgzInfo() {
  return req('/api/zgz/info')
}
export async function getZgzCount(dateFrom, dateTo) {
  const params = new URLSearchParams()
  if (dateFrom) params.set('dateFrom', dateFrom)
  if (dateTo) params.set('dateTo', dateTo)
  return req(`/api/zgz/count?${params}`)
}
// журнал найденных ЕО («Нашли» на карточке ЕО)
export async function addZgzFound(row) {
  return req('/api/zgz/found', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row) })
}
export async function getZgzFound(from, to) {
  return req(`/api/zgz/found?${new URLSearchParams({ from, to })}`)
}
export async function deleteZgzFound(id) {
  return req('/api/zgz/found/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
}
export async function deleteZgz(dateFrom, dateTo) {
  return req('/api/zgz/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dateFrom: dateFrom || null, dateTo: dateTo || null }),
  })
}

// Данные отчёта по операции за период (movedown/refill/placement/remains —
// строки, selection — агрегаты); shift пустой — обе смены каждой даты.
export async function getOpReport(op, dateFrom, dateTo, shift) {
  const params = new URLSearchParams({ dateFrom, dateTo })
  if (shift) params.set('shift', shift)
  return req(`/api/stats/report/${op}?${params}`)
}

// Расстановка товара: строки штучного отбора по ячейке × товару за период
export async function getSlotting(dateFrom, dateTo) {
  return req(`/api/stats/slotting?${new URLSearchParams({ dateFrom, dateTo })}`)
}

// Выработка «сотрудник × смена» (units, qty, grams, hours) — итоги смены и нормы.
// op: receiving | placement | movedown | refill | kdk | piece; shift пустой — обе смены.
export async function getWorkload(op, dateFrom, dateTo, shift) {
  const params = new URLSearchParams({ op, dateFrom, dateTo })
  if (shift) params.set('shift', shift)
  return req(`/api/stats/workload?${params}`)
}

// то же за точный интервал времени (ISO) — итог смены за произвольный период
export async function getWorkloadInterval(op, from, to) {
  return req(`/api/stats/workload?${new URLSearchParams({ op, from, to })}`)
}

// Приёмка построчно за период (вкладка «За период»); shift пустой — обе смены.
export async function getReceivingPeriodRows(dateFrom, dateTo, shift) {
  const params = new URLSearchParams({ dateFrom, dateTo })
  if (shift) params.set('shift', shift)
  return req(`/api/stats/receiving/period-rows?${params}`)
}

// Приёмка построчно (поставки) — для Excel-отчёта; те же shift/интервал, что у сводки.
export async function getReceivingRows(dateStr, { shift, completedFrom, completedTo } = {}) {
  const params = new URLSearchParams()
  if (shift) params.set('shift', shift)
  if (completedFrom && completedTo) { params.set('completedFrom', completedFrom); params.set('completedTo', completedTo) }
  return req(`/api/date/${dateStr}/receiving/rows?${params}`)
}
export const getMovedownDateSummary = opDateSummary('movedown')
export const getRefillDateSummary = opDateSummary('refill')

export async function getStatus() {
  return req('/api/status')
}

// `executors` — [{executorId, fio}, ...] (форма `newEmployees` из
// StatsPage.jsx/save-fetched-data). Бэкенд (`EmployeeAddNewRequest`,
// dotnet) принимает либо `executors` (объекты с executorId — так
// сотрудник добавляется сразу с реальным executorId, без ФИО-фоллбека),
// либо `names` (просто строки ФИО, без executorId — устаревший путь для
// значений без известного executorId). Раньше здесь всегда слали `names`
// с массивом ОБЪЕКТОВ {executorId, fio} — бэкенд пытался распарсить их как
// List<string> и падал 400 Bad Request.
// Проверка учёток ТСД (вход в WMS по телефону и паролю из списка сотрудников)
export async function getAccountChecks() {
  return req('/api/empl/account-checks')
}

export async function checkAccounts(executorIds) {
  return req('/api/empl/account-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ executorIds }),
  })
}

export async function addNewEmployees(executors) {
  return req('/api/empl/add-new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ executors }),
  })
}

export async function requestFetch() {
  return req('/api/vs/request-fetch', { method: 'POST' })
}

// Вызывается устройством с включённым автообновлением (AutoFetchCard) после
// завершения фетча — обновляет status.lastRun и сбрасывает fetchRequested,
// чтобы остальные устройства увидели актуальное время и не слали повторных
// запросов.
export async function markUpdated() {
  return req('/api/vs/mark-updated', { method: 'POST' })
}

// ─── Мониторинг смены (перекличка + живая активность) ──────────────────────

export async function getDateItems(dateStr, { shift } = {}) {
  const params = new URLSearchParams()
  if (shift) params.set('shift', shift)
  return req(`/api/date/${dateStr}/items?${params}`)
}

export async function getRollcall() {
  return req('/api/rollcall')
}

export async function putRollcall(shiftKey, present) {
  return req('/api/rollcall', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shiftKey, present }),
  })
}

// Живой мониторинг через наш бэкенд (серверный токен WMS из config.json) —
// когда в браузере нет своего токена WMS (иначе MonitorPage ходит в WMS сама).
export async function getLiveMonitor() {
  return req('/api/monitor/live')
}

// ─── Жалобы на нарушения («Консолидация») ───────────────────────────────────

// from/to — ISO-границы даты подачи (необязательные)
export async function getConsolidationComplaints({ from, to } = {}) {
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  return req(`/api/consolidation/complaints?${params}`)
}

// Кио­ск-форма подачи жалобы (ConsolidationFormPage) — POST с фото
// (multipart/form-data), напрямую fetch, не через req() (как и в оригинале),
// т.к. тело — FormData, а не JSON.
export async function createComplaint(formData) {
  const r = await fetch('/api/consolidation/complaints', { method: 'POST', credentials, headers: apiHeaders(), body: formData })
  const data = await r.json().catch(() => null)
  if (!r.ok || !data?.ok) throw new Error(data?.error || 'Ошибка отправки')
  return data
}

export async function saveComplaintLookup(id, data) {
  return req(`/api/consolidation/complaints/${encodeURIComponent(id)}/lookup`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function deleteComplaint(id) {
  return req(`/api/consolidation/complaints/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function exportConsolidationReport(reportNum, { dateFrom, dateTo, companyFullNames, fineAmount }) {
  const r = await fetch(`/api/consolidation/export/report${reportNum}`, {
    method: 'POST',
    credentials,
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ dateFrom, dateTo, companyFullNames, fineAmount }),
  })
  if (!r.ok) {
    let msg = r.statusText
    try { msg = (await r.json())?.error || msg } catch { /* ignore */ }
    throw new Error(msg)
  }
  return r.blob()
}

// ─── Нарушения (видео-лог инцидентов, отдельная сущность от «Консолидации») ─

export async function getViolations() {
  return req('/api/violations')
}

export async function createViolation(formData) {
  const r = await fetch('/api/violations', { method: 'POST', credentials, headers: apiHeaders(), body: formData })
  const data = await r.json().catch(() => null)
  if (!r.ok) throw new Error(data?.error || 'Ошибка загрузки')
  return data
}

export async function deleteViolation(id) {
  return req(`/api/violations/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ─── Мотивация аутсорса (/api/motivation/*, dotnet MotivationService) ───────

const jsonBody = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export async function saveMotivationSettings(settings) {
  return req('/api/motivation/settings', jsonBody('PUT', settings))
}

export async function addMotivationPeople({ date, shift, receivedAt, fromStats = false, people }) {
  return req('/api/motivation/people', jsonBody('POST', { date, shift, receivedAt, fromStats, people }))
}

export async function updateMotivationPerson(id, patch) {
  return req(`/api/motivation/people/${id}`, jsonBody('PUT', patch))
}

export async function deleteMotivationPerson(id) {
  return req(`/api/motivation/people/${id}`, { method: 'DELETE' })
}

export async function getMotivationCalculation(date, shift) {
  return req(`/api/motivation/calculate?${new URLSearchParams({ date, shift })}`)
}
