// Расчёты «Графика поставок»: итоги плана, сверка с WMS по номеру заказа,
// прогноз СЗ КДК по истории. Без React — проверяется отдельно.

export const SUPPLY_GROUPS = [
  { key: 'kdk', label: 'КДК (кросс-докинг)', match: t => /кросс/i.test(t) },
  { key: 'storage', label: 'Хранение', match: t => /хранен/i.test(t) },
]
export const STORAGE_ORDER = ['Сухой', 'Средний холод', 'Низкий холод']

const ACCEPTED = new Set(['COMPLETED_AS_PLANNED', 'COMPLETED_WITH_DISCREPANCY'])

export const groupOf = supplyType => SUPPLY_GROUPS.find(g => g.match(supplyType || ''))?.key || 'other'

const emptyTotals = () => ({ count: 0, pieces: 0, weightKg: 0, sku: 0 })
const add = (t, r) => { t.count += 1; t.pieces += r.pieces; t.weightKg += r.weightKg; t.sku += r.sku }

// Итоги: всего, по группе (КДК/хранение) и группа × тип хранения.
export function summarize(rows) {
  const total = emptyTotals()
  const groups = {}
  for (const r of rows) {
    add(total, r)
    const g = groupOf(r.supplyType)
    groups[g] = groups[g] || { totals: emptyTotals(), byStorage: {} }
    add(groups[g].totals, r)
    const st = r.storageType || '—'
    groups[g].byStorage[st] = groups[g].byStorage[st] || emptyTotals()
    add(groups[g].byStorage[st], r)
  }
  return { total, groups }
}

export const storageKeys = byStorage => Object.keys(byStorage)
  .sort((a, b) => (STORAGE_ORDER.indexOf(a) + 1 || 99) - (STORAGE_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b, 'ru'))

// Сверка плана с заданиями WMS по номеру заказа.
//  status: accepted | discrepancy | notVerified (приёмка завершена, ждёт
//  проверки) | cancelled | inProgress (ещё не приняли) | missing; факт — только
//  у принятых (COMPLETED_*), как считает сам WMS.
//  extra — принятые в смены даты задания, которых нет в графике.
export function reconcile(planRows, tasks, date) {
  const byOrder = new Map()
  for (const t of tasks) {
    if (!t.orderNumber) continue
    const cur = byOrder.get(t.orderNumber)
    // одним заказом бывает несколько заданий — предпочитаем принятое
    if (!cur || (!ACCEPTED.has(cur.status) && ACCEPTED.has(t.status))) byOrder.set(t.orderNumber, t)
  }
  const factOf = t => ({
    pieces: Number(t.actualQuantities?.pieceProducts) || 0,
    weightKg: (Number(t.actualTotalWeight) || 0) / 1000,
    sku: Number(t.productsQuantity) || 0,
  })
  const planOrders = new Set(planRows.map(r => r.orderNumber))
  const rows = planRows.map(r => {
    const t = byOrder.get(r.orderNumber)
    const status = !t ? 'missing'
      : t.status === 'COMPLETED_AS_PLANNED' ? 'accepted'
      : t.status === 'COMPLETED_WITH_DISCREPANCY' ? 'discrepancy'
      : t.status === 'NOT_VERIFIED' ? 'notVerified'
      : t.status === 'CANCELLED' ? 'cancelled'
      : 'inProgress'
    return { ...r, task: t || null, status, wmsStatus: t?.status || null, fact: ACCEPTED.has(t?.status) ? factOf(t) : null, completedAt: t?.completedAt || null, gate: t?.gateInfo?.gateNumber || '' }
  })
  // вне графика: принятые с завершением в смены даты (09:00 даты → 09:00 следующей)
  const from = new Date(`${date}T09:00:00+03:00`).getTime()
  const to = from + 24 * 3600000
  const extra = tasks
    .filter(t => ACCEPTED.has(t.status) && t.completedAt && !planOrders.has(t.orderNumber))
    .filter(t => { const c = new Date(t.completedAt).getTime(); return c >= from && c < to })
    .map(t => ({ orderNumber: t.orderNumber || '—', supplier: t.supplier?.name || '', supplyType: t.type, storageType: t.temperatureMode, task: t, status: 'extra', fact: factOf(t), completedAt: t.completedAt, gate: t.gateInfo?.gateNumber || '' }))
  return { rows, extra }
}

// Итоги факта (принятые из графика + вне графика) в разрезе КДК/хранение.
export function summarizeFact(rows, extra) {
  const accepted = rows.filter(r => r.fact)
  const map = r => ({ ...r, pieces: r.fact.pieces, weightKg: r.fact.weightKg, sku: r.fact.sku })
  // у заданий вне графика тип поставки в кодах WMS: CROSSDOCK → кросс-докинг
  const extraRows = extra.map(e => ({ ...map(e), supplyType: e.supplyType === 'CROSSDOCK' ? 'Кросс-докинг' : 'Хранение', storageType: { ORDINARY: 'Сухой', MEDIUM_COLD: 'Средний холод', LOW_COLD: 'Низкий холод' }[e.storageType] || e.storageType }))
  return summarize([...accepted.map(map), ...extraRows])
}

export const pct = (fact, plan) => (plan ? (fact - plan) / plan : null)

// ── Прогноз СЗ КДК ──────────────────────────────────────────────────────────
// История: план кросс-дока по дням × фактические СЗ КДК по дате смены.
// Перебираем показатель (SKU / штуки / поставки) и сдвиг (СЗ в тот же день
// или на следующий) — берём пару с наименьшей ошибкой на последних днях.
// Прогноз = медиана «СЗ на единицу показателя» × план выбранной даты.
const median = a => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null }
const nextDay = (d, k) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10) }

export function forecastKdk(history, date, plan) {
  const plans = new Map((history?.plans || []).map(p => [p.date, p]))
  const picks = new Map((history?.picks || []).map(p => [p.date, p.tasks]))
  const metrics = [
    { key: 'sku', label: 'SKU кросс-дока', per: 'на SKU' },
    { key: 'pieces', label: 'штук кросс-дока', per: 'на штуку' },
    { key: 'deliveries', label: 'поставок кросс-дока', per: 'на поставку' },
  ]
  let best = null
  for (const m of metrics) {
    for (const lag of [0, 1]) {
      const pairs = []
      for (const [d, p] of plans) {
        if (d >= date) continue
        const tasks = picks.get(nextDay(d, lag))
        if (tasks > 0 && p[m.key] > 0) pairs.push({ d, x: p[m.key], y: tasks })
      }
      pairs.sort((a, b) => (a.d < b.d ? 1 : -1))
      const recent = pairs.slice(0, 28)
      if (recent.length < 7) continue
      const k = median(recent.map(p => p.y / p.x))
      const err = median(recent.map(p => Math.abs(k * p.x - p.y) / p.y))
      if (!best || err < best.err) best = { metric: m, lag, k, err, days: recent.length }
    }
  }
  if (!best) return { ok: false, days: Math.min(plans.size, picks.size) }
  const x = plan[best.metric.key]
  return { ok: true, value: Math.round(best.k * x), ...best, x, shiftDate: nextDay(date, best.lag) }
}

// План кросс-дока даты в форме истории (для прогноза).
// коэффициент прогноза по-русски: «90,71»
export const fmtK = k => k.toLocaleString('ru-RU', { maximumFractionDigits: 2 })

export const kdkPlanOf = rows => {
  const kdk = rows.filter(r => groupOf(r.supplyType) === 'kdk')
  return { deliveries: kdk.length, sku: kdk.reduce((s, r) => s + r.sku, 0), pieces: kdk.reduce((s, r) => s + r.pieces, 0) }
}

// ── Хранение сверки и период ────────────────────────────────────────────────
// Сверка дня сохраняется на сервере (supply_plan_facts): строки графика со
// статусом и фактом + «вне графика» (extra). Из сохранённого строится
// накопительный отчёт и рейтинг поставщиков за период без повторных запросов в WMS.
const FACT_STATUSES = new Set(['accepted', 'discrepancy'])

export function toFactRows(recon) {
  const one = (r, extra) => ({
    orderNumber: r.orderNumber, extra, supplier: r.supplier || '', supplyType: r.supplyType || '', storageType: extra ? r.storageType || '' : '',
    status: r.status, wmsStatus: r.wmsStatus || r.task?.status || '',
    factSku: r.fact?.sku ?? null, factPieces: r.fact?.pieces ?? null, factWeightKg: r.fact?.weightKg ?? null,
    completedAt: r.completedAt || null, gate: r.gate || '',
  })
  return [...recon.rows.map(r => one(r, false)), ...recon.extra.map(r => one(r, true))]
}

const factOfSaved = f => (f.factPieces != null || f.factSku != null ? { sku: f.factSku || 0, pieces: f.factPieces || 0, weightKg: f.factWeightKg || 0 } : null)

// Восстановить сверку дня из сохранённого факта (null — день не сверяли).
export function fromFactRows(planRows, facts) {
  if (!facts?.length) return null
  const byOrder = new Map(facts.filter(f => !f.extra).map(f => [f.orderNumber, f]))
  const rows = planRows.map(r => {
    const f = byOrder.get(r.orderNumber)
    if (!f) return { ...r, status: 'missing', wmsStatus: null, fact: null, completedAt: null, gate: '' }
    return { ...r, status: f.status || 'missing', wmsStatus: f.wmsStatus || null, fact: FACT_STATUSES.has(f.status) ? factOfSaved(f) : null, completedAt: f.completedAt, gate: f.gate }
  })
  const extra = facts.filter(f => f.extra).map(f => ({
    orderNumber: f.orderNumber, supplier: f.supplier, supplyType: f.supplyType, storageType: f.storageType,
    status: 'extra', wmsStatus: f.wmsStatus, fact: factOfSaved(f) || { sku: 0, pieces: 0, weightKg: 0 }, completedAt: f.completedAt, gate: f.gate,
  }))
  const at = facts.reduce((m, f) => (f.checkedAt && f.checkedAt > m ? f.checkedAt : m), '')
  return { rows, extra, at: at ? new Date(at) : null, saved: true }
}

const byDate = list => {
  const m = new Map()
  for (const x of list || []) { if (!m.has(x.date)) m.set(x.date, []); m.get(x.date).push(x) }
  return m
}

// Итоги по дням периода — лист «статистика» накопительного отчёта.
// Факт: из сохранённой сверки (принятые + вне графика), иначе — из истории
// накопительного отчёта (supply_day_facts), иначе пусто.
export function dayStats({ plans, facts, dayFacts }, from, to) {
  const planBy = byDate(plans), factBy = byDate(facts)
  const histBy = new Map((dayFacts || []).map(d => [d.date, d]))
  const out = []
  for (let d = from; d <= to; d = nextDay(d, 1)) {
    const p = planBy.get(d) || [], f = factBy.get(d)
    const plan = { count: p.length, pieces: 0, weightKg: 0, sku: 0 }
    for (const r of p) { plan.pieces += r.pieces; plan.weightKg += r.weightKg; plan.sku += r.sku }
    let fact = null, source = null
    if (f?.length) {
      fact = { count: 0, pieces: 0, weightKg: 0, sku: 0 }
      for (const x of f) {
        if (!(x.extra || FACT_STATUSES.has(x.status))) continue
        fact.count++; fact.pieces += x.factPieces || 0; fact.weightKg += x.factWeightKg || 0; fact.sku += x.factSku || 0
      }
      source = 'wms'
    } else if (histBy.has(d)) {
      const h = histBy.get(d)
      fact = { count: h.count || 0, pieces: h.pieces || 0, weightKg: h.weightKg || 0, sku: h.sku || 0 }
      source = 'report'
    }
    if (!p.length && !fact) continue
    out.push({ date: d, plan, fact, source })
  }
  return out
}

// Рейтинг поставщиков за период по сохранённым сверкам: только дни, где
// сверка была. Недовоз — сколько штук из плана принятых заказов не довезли.
export function supplierRating({ plans, facts }) {
  const checked = new Set((facts || []).map(f => f.date))
  const factKey = new Map((facts || []).filter(f => !f.extra).map(f => [`${f.date}|${f.orderNumber}`, f]))
  const by = new Map()
  const get = name => {
    const k = (name || '—').trim() || '—'
    if (!by.has(k)) by.set(k, { supplier: k, planned: 0, accepted: 0, discrepancy: 0, waiting: 0, notArrived: 0, cancelled: 0, extra: 0, planPieces: 0, factPieces: 0, extraPieces: 0, days: new Set() })
    return by.get(k)
  }
  for (const p of plans || []) {
    if (!checked.has(p.date)) continue
    const s = get(p.supplier)
    const f = factKey.get(`${p.date}|${p.orderNumber}`)
    const st = f?.status || 'missing'
    s.planned++
    s.days.add(p.date)
    if (st === 'accepted') s.accepted++
    else if (st === 'discrepancy') s.discrepancy++
    else if (st === 'cancelled') s.cancelled++
    else if (st === 'missing') s.notArrived++
    else s.waiting++ // inProgress / notVerified — приехала, но ещё не принята
    if (FACT_STATUSES.has(st)) { s.planPieces += p.pieces; s.factPieces += f.factPieces || 0 }
  }
  for (const f of facts || []) {
    if (!f.extra) continue
    const s = get(f.supplier)
    s.extra++
    s.extraPieces += f.factPieces || 0
  }
  return [...by.values()].map(s => {
    const shortfall = s.planPieces ? Math.max(0, s.planPieces - s.factPieces) / s.planPieces : null
    const notArrivedPct = s.planned ? s.notArrived / s.planned : null
    const discrepancyPct = s.planned ? s.discrepancy / s.planned : null
    return { ...s, days: s.days.size, shortfall, notArrivedPct, discrepancyPct }
  })
}

// ── Прогноз приёмщиков ──────────────────────────────────────────────────────
// История: план дня (штуки / вес / поставки) × сколько приёмщиков реально
// работало в смены этой даты (/api/stats/workload?op=receiving; приёмщик —
// от 2 отработанных часов, чтобы разовые закрытия не раздували число).
// Как и для СЗ КДК: перебираем показатель, берём с наименьшей ошибкой.
export function forecastReceivers(planRows, workRows, date, plan) {
  const plans = new Map()
  for (const r of planRows || []) {
    const p = plans.get(r.date) || { pieces: 0, weightKg: 0, count: 0 }
    p.pieces += r.pieces; p.weightKg += r.weightKg; p.count++
    plans.set(r.date, p)
  }
  const people = new Map() // date → { all:Set, day:Set, night:Set, hours, pieces }
  for (const w of workRows || []) {
    if (w.hours < 2) continue
    const d = people.get(w.shiftDate) || { all: new Set(), day: new Set(), night: new Set(), hours: 0, pieces: 0 }
    const id = w.executorId || w.name
    d.all.add(id); d[w.shift]?.add(id); d.hours += w.hours; d.pieces += Number(w.qty) || 0
    people.set(w.shiftDate, d)
  }
  const metrics = [
    { key: 'pieces', label: 'штук', unit: 'штук' },
    { key: 'weightKg', label: 'кг', unit: 'кг' },
    { key: 'count', label: 'поставок', unit: 'поставок' },
  ]
  let best = null
  for (const m of metrics) {
    const pairs = []
    for (const [d, p] of plans) {
      const w = people.get(d)
      if (d >= date || !w?.all.size || !(p[m.key] > 0)) continue
      pairs.push({ d, x: p[m.key], y: w.all.size, w })
    }
    pairs.sort((a, b) => (a.d < b.d ? 1 : -1))
    const recent = pairs.slice(0, 28)
    if (recent.length < 7) continue
    const k = median(recent.map(p => p.y / p.x))
    const err = median(recent.map(p => Math.abs(k * p.x - p.y) / p.y))
    if (!best || err < best.err) best = { metric: m, k, err, days: recent.length, recent }
  }
  if (!best) return { ok: false, days: [...plans.keys()].filter(d => people.has(d)).length }
  const x = plan[best.metric.key]
  const value = Math.max(1, Math.round(best.k * x))
  const dayShare = median(best.recent.map(p => p.w.day.size / ((p.w.day.size + p.w.night.size) || 1)))
  const perHour = median(best.recent.filter(p => p.w.hours).map(p => p.w.pieces / p.w.hours))
  const day = Math.round(value * dayShare)
  return { ok: true, value, day, night: Math.max(0, value - day), x, perPerson: 1 / best.k, perHour, ...best }
}
