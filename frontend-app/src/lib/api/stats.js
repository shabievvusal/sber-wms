// Статистика и отчёты: сводки за день/месяц по операциям, выработка, расстановка, «Обновлено», перекличка.
import { apiHeaders, req } from './core.js'

export async function getDateSummaryFull(dateStr, { shift, idleThresholdMinutes } = {}) {
  const params = new URLSearchParams()
  if (shift) params.set('shift', shift)
  if (idleThresholdMinutes != null) params.set('idleThresholdMinutes', idleThresholdMinutes)
  return req(`/api/date/${dateStr}/summary?${params}`, { cache: 'no-store' })
}

export async function uploadStockConsolidationReport(tasksCsvFile, stockXlsxFile, temperature) {
  const fd = new FormData()
  fd.append('tasksCsv', tasksCsvFile)
  fd.append('stockXlsx', stockXlsxFile)
  fd.append('temperature', temperature)
  const r = await fetch('/api/reports/stock-consolidation', { method: 'POST', credentials: 'include', headers: apiHeaders(), body: fd })
  const data = await r.json()
  if (!r.ok) throw new Error(data.error || 'Ошибка загрузки')
  return data
}

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
