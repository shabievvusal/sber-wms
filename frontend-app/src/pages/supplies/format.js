// Общие форматтеры для SuppliesPage/SupplyDetailPage — перенесены из
// оригинала (был продублирован один в один в обоих файлах), включая формат
// дат с 2-значным годом — так было в исходнике, не 4-значный.

export function fmtNum(n) {
  if (n == null || Number.isNaN(n)) return '—'
  return Number(n).toLocaleString('ru-RU')
}

export function fmtWeight(grams) {
  if (grams == null || grams === 0) return '—'
  const kg = grams / 1000
  return `${kg % 1 === 0 ? fmtNum(kg) : Number(kg.toFixed(3)).toLocaleString('ru-RU')} кг`
}

export function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`
}

export function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}, ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fioShort(user) {
  if (!user) return '—'
  const { lastName, firstName, middleName } = user
  const initials = [firstName, middleName].filter(Boolean).map(p => p[0].toUpperCase() + '.').join('')
  return [lastName, initials].filter(Boolean).join(' ') || '—'
}

// Границы дня в МСК для реальных WMS-запросов (getInboundTasks и т.д.).
export function dateToApiFrom(dateStr) {
  return new Date(`${dateStr}T00:00:00+03:00`).toISOString()
}
export function dateToApiTo(dateStr) {
  return new Date(`${dateStr}T23:59:59.999+03:00`).toISOString()
}

// Извлечь число из { pieceProducts: N } / { weightProducts: N } или из числа.
export function qty(val) {
  if (val == null) return null
  if (typeof val === 'number') return val
  return val.pieceProducts ?? val.weightProducts ?? null
}
