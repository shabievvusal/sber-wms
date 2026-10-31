// Настройки: автообновление, сотрудники и проверка учёток, веса товаров, удаление данных за смену.
import { apiHeaders, req } from './core.js'

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

export async function getProductWeightsInfo() {
  return req('/api/vs/admin/product-weights/info')
}

export async function uploadProductWeightsExcel(file) {
  const fd = new FormData()
  fd.append('file', file)
  const r = await fetch('/api/vs/admin/product-weights/upload', { method: 'POST', credentials: 'include', headers: apiHeaders(), body: fd })
  const data = await r.json()
  if (!r.ok) throw new Error(data.error || 'Ошибка загрузки')
  return data
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
