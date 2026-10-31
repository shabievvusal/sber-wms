// «Консолидация» — жалобы на нарушения: подача с фото, результат поиска в WMS, Excel-отчёты.
import { apiHeaders, credentials, req } from './core.js'

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
