// График поставок: загрузка файла, сверка с WMS, период, история для прогноза СЗ КДК.
import { apiHeaders, req } from './core.js'

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
