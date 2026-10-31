// Выдача ТСД (терминалов сбора данных): настройки, выдача и возврат, сотрудники без учётки WMS.
import { req } from './core.js'

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
