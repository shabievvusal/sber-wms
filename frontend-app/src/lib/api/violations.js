// «Нарушения» — видео-журнал инцидентов (отдельно от «Консолидации»).
import { apiHeaders, credentials, req } from './core.js'

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
