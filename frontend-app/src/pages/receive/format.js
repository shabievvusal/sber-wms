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
