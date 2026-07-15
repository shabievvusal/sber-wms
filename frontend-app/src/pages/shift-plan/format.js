// Перенесено из оригинала (frontend/app/src/pages/shift-plan/ShiftPlanPage.jsx).

export function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function daysAgoStr(days) {
  const d = new Date(Date.now() - days * 86_400_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function fmtNum(value, digits = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/** ≥100% плана — «ok», 90-99.9% — «warn», <90% — «bad», без цели — «neutral». */
export function planStatus(projected, target) {
  if (!target) return 'neutral'
  if (projected >= target) return 'ok'
  if (projected >= target * 0.9) return 'warn'
  return 'bad'
}
