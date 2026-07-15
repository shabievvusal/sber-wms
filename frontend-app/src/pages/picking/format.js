// Форматтеры и мелкая логика, перенесённые из оригинала (Piece­SelectionPage.jsx/
// KdkLayoutPage.jsx/EoSearchPage.jsx) — числа, даты, ФИО. Общие для всех трёх
// страниц раздела «Комплектация».

export function fmtNum(n) {
  if (n === null || n === undefined || n === '') return '—'
  const num = Number(n)
  return Number.isFinite(num) ? num.toLocaleString('ru-RU') : String(n)
}

export function fmtKg(grams) {
  const n = Number(grams) || 0
  if (!n) return '—'
  return (n / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' кг'
}

export function fmtLiters(ml) {
  const n = Number(ml) || 0
  if (!n) return '—'
  return (n / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' л'
}

/** "2026-07-12..." → "12.07.2026" — строковый разбор без Date, чтобы не словить сдвиг часового пояса. */
export function fmtDay(dateStr) {
  if (!dateStr) return '—'
  const [y, m, d] = String(dateStr).slice(0, 10).split('-')
  return `${d}.${m}.${y}`
}

export function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function formatTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fmtAgo(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(diff) || diff < 0) return ''
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'только что'
  return `${min} мин`
}

export function userName(user) {
  if (!user) return '—'
  return [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || '—'
}

/** "Иванов Иван Иванович" → "Иванов И.И." */
export function shortFio(name) {
  if (!name) return '—'
  const parts = String(name).trim().split(/\s+/)
  if (parts.length < 2) return name
  const last = parts[0]
  const initials = parts.slice(1).map(p => p[0] ? p[0].toUpperCase() + '.' : '').join('')
  return last + ' ' + initials
}

export function selectedOrAll(selected, options, valueKey) {
  return selected ? [selected] : options.map(option => option[valueKey])
}

// Границы дня в МСК (+03:00) для WMS-запросов (dateFrom/dateTo) — реальные
// браузерные вызовы в api.samokat.ru используют именно этот формат.
export function dateToApiFrom(date) {
  if (!date) return ''
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return new Date(`${y}-${m}-${d}T00:00:00+03:00`).toISOString()
}

export function dateToApiTo(date) {
  if (!date) return ''
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return new Date(`${y}-${m}-${d}T23:59:59.999+03:00`).toISOString()
}
