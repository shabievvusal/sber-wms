// Минимальный API-слой для превью редизайна. Бьёт в тот же бэкенд (см. vite.config.js proxy),
// намеренно НЕ импортирует ../../app/src/api/index.js — песочница должна оставаться независимой.
const credentials = 'include'

async function req(url, opts = {}) {
  const r = await fetch(url, { credentials, ...opts })
  const text = await r.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error(`Сервер вернул не JSON (${r.status}): ${text.slice(0, 150)}`)
  }
  if (!r.ok) throw new Error(data?.error || r.statusText || `HTTP ${r.status}`)
  return data
}

// ─── Auth (сессия /api/vs/auth/*) ───────────────────────────────────────────

export async function loginVs(login, password) {
  return req('/api/vs/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, password }),
  })
}

export async function registerVs(data) {
  return req('/api/vs/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

// Не через req() — 401 здесь означает «нет сессии», а не ошибку.
export async function getVsMe() {
  const r = await fetch('/api/vs/auth/me', { credentials })
  if (!r.ok) return null
  return r.json()
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
// сессии в wwh.samokat.ru (см. PLAN.md, «единственное легитимное место для JS»).
// FetchModal ниже честно показывает это ограничение, а не притворяется, что скачал данные.

// ─── Приёмка (кио­ск отгрузки/приёмки РК) ───────────────────────────────────
// searchRkRoutes/submitRkShipment/submitRkReceiving — POST-эндпоинты кладовщика
// (без сессии), не путать с updateRkShipment/updateRkReceiving выше (PUT,
// редактирование администратором из ShipmentsPage — это два разных реальных
// роута на бэкенде, см. PLAN.md).

export async function searchRkRoutes({ mode, q } = {}) {
  const params = new URLSearchParams()
  if (mode) params.set('mode', mode)
  if (q) params.set('q', q)
  return req(`/api/rk/routes-search?${params}`)
}

export async function getDriverRokhlyaDebt(name) {
  const params = new URLSearchParams({ name })
  return req(`/api/rk/driver-rokhlya-debt?${params}`)
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

export async function uploadRkPhotos(files) {
  const form = new FormData()
  for (const f of files) form.append('photos', f)
  const r = await fetch('/api/rk/photos', { method: 'POST', credentials, body: form })
  const data = await r.json().catch(() => null)
  if (!r.ok) throw new Error(data?.error || 'Ошибка загрузки фото')
  return data
}

export async function requestEoRefresh(routeId) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/eos/request-refresh`, { method: 'POST' })
}

// Реальное сохранение ЕО, уже полученных браузером напрямую из WMS
// (fetchRouteFromWMS в wmsFetch.js) — в отличие от requestEoRefresh выше
// (постановка в очередь для устройства без токена), тут данные уже на руках.
export async function saveRouteEosRefresh(routeId, wmsData) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/eos/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
// поднятого Postgres сервер отвечает 503 (см. PLAN.md).

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

export async function deleteProductWeightsExcel() {
  return req('/api/vs/admin/product-weights', { method: 'DELETE' })
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

export async function upgradeFioIds() {
  return req('/api/empl/upgrade-fio-ids', { method: 'POST' })
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

function monthlyOpEmployees(path) {
  return async (dateFrom, dateTo, shift) => {
    const params = new URLSearchParams({ dateFrom, dateTo })
    if (shift) params.set('shift', shift)
    return req(`/api/stats/${path}/monthly-employees?${params}`)
  }
}
export const getMonthlyPlacementEmployees = monthlyOpEmployees('placement')
export const getMonthlyReceivingEmployees = monthlyOpEmployees('receiving')
export const getMonthlyRemainsEmployees = monthlyOpEmployees('remains')

export async function getMonthlyCompany(year, month, shift) {
  const params = new URLSearchParams({ year, month })
  if (shift) params.set('shift', shift)
  return req(`/api/stats/monthly-company?${params}`)
}

function opDateSummary(path) {
  return async (dateStr, { shift, fromHour, toHour } = {}) => {
    const params = new URLSearchParams()
    if (shift) params.set('shift', shift)
    if (fromHour != null) params.set('fromHour', fromHour)
    if (toHour != null) params.set('toHour', toHour)
    return req(`/api/date/${dateStr}/${path}/summary?${params}`)
  }
}
export const getPlacementDateSummary = opDateSummary('placement')
export const getReceivingDateSummary = opDateSummary('receiving')
export const getRemainsDateSummary = opDateSummary('remains')

export async function getStatus() {
  return req('/api/status')
}

export async function getMissingWeight() {
  return req('/api/missing-weight')
}

export async function getMissingWeightStatus() {
  return req('/api/missing-weight/status')
}

export async function rebuildMissingWeight() {
  return req('/api/missing-weight/rebuild', { method: 'POST' })
}

// `executors` — [{executorId, fio}, ...] (форма `newEmployees` из
// StatsPage.jsx/save-fetched-data). Бэкенд (`EmployeeAddNewRequest`,
// dotnet) принимает либо `executors` (объекты с executorId — так
// сотрудник добавляется сразу с реальным executorId, без ФИО-фоллбека),
// либо `names` (просто строки ФИО, без executorId — устаревший путь для
// значений без известного executorId). Раньше здесь всегда слали `names`
// с массивом ОБЪЕКТОВ {executorId, fio} — бэкенд пытался распарсить их как
// List<string> и падал 400 Bad Request.
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

// Серверный фетч селекции данными из WMS собственным токеном бэкенда (без
// браузерного bearer-токена) — same-origin, в отличие от
// fetchDataViaBrowser/fetchPlacementViaBrowser/fetchRemainsViaBrowser
// оригинала (прямые браузерные вызовы в api.samokat.ru — не перенесены,
// см. PLAN.md).
export async function fetchData(payload) {
  return req('/api/fetch-data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  })
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

// Прокси через наш бэкенд (сервер хранит свой токен WMS) — путь по умолчанию.
// В оригинале есть ещё getLiveMonitorViaBrowser (прямой fetch в api.samokat.ru
// с токеном из localStorage) как алтернативный путь при закешированном
// браузерном токене WMS — в песочнице не переносим, см. PLAN.md.
export async function getLiveMonitor() {
  return req('/api/monitor/live')
}

// Собственная база операций (C#-тул), не WMS — среднее СЗ/чел/час по артикулу
// за период, используется как подсказка скорости в AnalysisPage.
export async function getArticleSpeeds({ dateFrom, dateTo, opType, zone } = {}) {
  const params = new URLSearchParams()
  if (dateFrom) params.set('dateFrom', dateFrom)
  if (dateTo) params.set('dateTo', dateTo)
  if (opType) params.set('opType', opType)
  if (zone) params.set('zone', zone)
  return req(`/api/analysis/article-speeds?${params}`)
}

// ─── Жалобы на нарушения (страница называется «Консолидация» по историческим
// причинам — см. PLAN.md) ────────────────────────────────────────────────────

export async function getConsolidationComplaints() {
  return req('/api/consolidation/complaints')
}

// Кио­ск-форма подачи жалобы (ConsolidationFormPage) — POST с фото
// (multipart/form-data), напрямую fetch, не через req() (как и в оригинале),
// т.к. тело — FormData, а не JSON.
export async function createComplaint(formData) {
  const r = await fetch('/api/consolidation/complaints', { method: 'POST', credentials, body: formData })
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
    headers: { 'Content-Type': 'application/json' },
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
  const r = await fetch('/api/violations', { method: 'POST', credentials, body: formData })
  const data = await r.json().catch(() => null)
  if (!r.ok) throw new Error(data?.error || 'Ошибка загрузки')
  return data
}

export async function deleteViolation(id) {
  return req(`/api/violations/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
