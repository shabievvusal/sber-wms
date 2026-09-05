export function fmtDate(iso) {
  if (!iso) return '—'
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}.${m}.${y}`
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

export function parseNum(v) {
  const s = String(v ?? '').replace(',', '.')
  return s !== '' && !isNaN(parseFloat(s)) ? parseFloat(s) : 0
}

export function parseTemp(v) {
  const s = String(v ?? '').replace(',', '.')
  return s !== '' && !isNaN(parseFloat(s)) ? parseFloat(s) : null
}

/** «сегодня в 14:32» / «05.09 в 14:32» — когда список ЕО последний раз
 * обновлялся из WMS. Кладовщик обновляет список не сам (у него нет
 * WMS-токена), поэтому без явного времени свежесть данных по экрану не
 * определить. */
export function fmtUpdatedAt(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d)) return null
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return `сегодня в ${time}`
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} в ${time}`
}
