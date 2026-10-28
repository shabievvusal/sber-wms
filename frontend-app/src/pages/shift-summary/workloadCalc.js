// Расчёты «Итогов смены» и сравнения с нормой по выработке сотрудник × смена
// (/api/stats/workload: units, qty, grams, hours). Производительность —
// показатель / отработанные часы (часы, в которые сотрудник что-то завершил).

export const OPS = [
  { key: 'receiving', label: 'Приёмка', unit: 'поставок', unitShort: 'пост.', metric: 'sku', main: 'sku', mainLabel: 'SKU' },
  { key: 'placement', label: 'Размещение', unit: 'операций', unitShort: 'опер.', metric: 'units' },
  { key: 'movedown', label: 'Спуск', unit: 'операций', unitShort: 'опер.', metric: 'units' },
  { key: 'refill', label: 'Пополнение', unit: 'операций', unitShort: 'опер.', metric: 'units' },
  { key: 'kdk', label: 'Раскладка КДК', unit: 'СЗ', unitShort: 'СЗ', metric: 'units' },
  { key: 'piece', label: 'Штучный отбор', unit: 'СЗ', unitShort: 'СЗ', metric: 'units' },
]
export const opMeta = key => OPS.find(o => o.key === key)
// главный показатель операции: у приёмки — SKU, у остальных — операции/СЗ
export const mainOf = op => op.main || 'units'
export const mainLabelOf = op => op.mainLabel || op.unit

// показатель для нормы: операции / штуки / кг
export const METRICS = {
  sku: { label: () => 'SKU', short: () => 'SKU', only: ['receiving'] },
  units: { label: op => opMeta(op).unit, short: op => opMeta(op).unitShort },
  qty: { label: () => 'штук', short: () => 'шт' },
  kg: { label: () => 'кг', short: () => 'кг' },
}
const valueOf = (a, metric) => (metric === 'kg' ? a.grams / 1000 : a[metric])

export const median = list => {
  const s = list.filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b)
  const n = s.length
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null
}

function sumBy(rows, keyFn) {
  const map = new Map()
  for (const r of rows) {
    const key = keyFn(r)
    let a = map.get(key)
    if (!a) map.set(key, (a = { key, executorId: r.executorId, name: r.name, company: r.company, units: 0, sku: 0, qty: 0, grams: 0, hours: 0, shifts: new Set() }))
    if (r.name) a.name = r.name
    a.units += r.units
    a.sku += Number(r.sku) || 0
    a.qty += Number(r.qty) || 0
    a.grams += Number(r.grams) || 0
    a.hours += r.hours
    a.shifts.add(`${r.shiftDate}|${r.shift}`)
  }
  return [...map.values()]
}
const personKey = r => r.executorId || r.name || '—'

// ── Итог смены ──────────────────────────────────────────────────────────────
// По операции: итоги, сотрудники, чел·часы, выработка в час и топ сотрудников.
export function shiftSummary(rows, top = 5, main = 'units') {
  const people = sumBy(rows, personKey).sort((a, b) => b[main] - a[main] || b.units - a.units)
  const t = { units: 0, sku: 0, qty: 0, grams: 0, hours: 0 }
  for (const p of people) { t.units += p.units; t.sku += p.sku; t.qty += p.qty; t.grams += p.grams; t.hours += p.hours }
  return {
    ...t,
    kg: t.grams / 1000,
    people: people.length,
    main: t[main],
    perHour: t.hours ? t[main] / t.hours : null,
    top: people.slice(0, top).map(p => ({ ...p, main: p[main], kg: p.grams / 1000, perHour: p.hours ? p[main] / p.hours : null })),
    all: people,
  }
}

// ── Сравнение с нормой ──────────────────────────────────────────────────────
// Норма — медиана выработки в час среди сотрудников, у кого за период не
// меньше minHours часов (случайные пара часов не сдвигают норму). Динамика —
// выработка во второй половине периода против первой.
export function compareToNorm(rows, { metric, from, to, minHours = 10 }) {
  const mid = midDate(from, to)
  const people = sumBy(rows, personKey).map(p => {
    const mine = rows.filter(r => personKey(r) === p.key)
    const half = list => {
      const h = list.reduce((s, r) => s + r.hours, 0)
      const v = list.reduce((s, r) => s + valueOf({ units: r.units, sku: Number(r.sku) || 0, qty: Number(r.qty) || 0, grams: Number(r.grams) || 0 }, metric), 0)
      return h >= 3 ? v / h : null
    }
    const first = half(mine.filter(r => r.shiftDate < mid))
    const second = half(mine.filter(r => r.shiftDate >= mid))
    const value = valueOf(p, metric)
    return {
      key: p.key, name: p.name || '—', company: p.company || '—',
      shifts: p.shifts.size, hours: p.hours, units: p.units, qty: p.qty, kg: p.grams / 1000, value,
      rate: p.hours ? value / p.hours : null,
      perShift: p.shifts.size ? value / p.shifts.size : null,
      trend: first && second ? second / first - 1 : null,
      enough: p.hours >= minHours,
    }
  })
  const norm = median(people.filter(p => p.enough).map(p => p.rate))
  for (const p of people) p.toNorm = norm && p.rate != null ? p.rate / norm : null
  return { people, norm, counted: people.filter(p => p.enough).length }
}

function midDate(from, to) {
  const a = new Date(`${from}T00:00:00Z`).getTime(), b = new Date(`${to}T00:00:00Z`).getTime()
  const days = Math.round((b - a) / 86400000)
  return new Date(a + Math.ceil((days + 1) / 2) * 86400000).toISOString().slice(0, 10)
}
