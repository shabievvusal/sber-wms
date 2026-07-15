// Форматтеры и справочники — перенесены из оригинала HourlyReport.jsx
// один в один (по прямому запросу пользователя — раздел «Отчёт каждый час»
// переносится точь-в-точь, без переосмысления).

export function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

/** Окно для запроса РК-маршрутов за календарный день МСК: дата-1 21:00Z → дата 20:59:59.999Z. */
export function inboundWindow(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const from = new Date(Date.UTC(y, m - 1, d - 1, 21, 0, 0, 0))
  const to = new Date(Date.UTC(y, m - 1, d, 20, 59, 59, 999))
  return { from: from.toISOString(), to: to.toISOString() }
}

// Окно смены (18:00 UTC день-1 → 18:00 UTC день) для getReportMonitoringStats —
// тот же хелпер, что и в analysis/format.js, задублирован намеренно (в
// оригинале это тоже два независимых копипаст-определения в разных файлах).
export function shiftWindow(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const from = new Date(Date.UTC(y, m - 1, d - 1, 18, 0, 0, 0))
  const to = new Date(Date.UTC(y, m - 1, d, 18, 0, 0, 0))
  return { from: from.toISOString(), to: to.toISOString() }
}

export function parseMonitoringStats(data) {
  const v = data?.value
  if (!v) return null
  const pick = block => ({
    tasks: block?.totalTasks?.tasksCount ?? 0,
    done: block?.completedTasks?.tasksCount ?? 0,
    rest: block?.remainingTasks?.tasksCount ?? 0,
  })
  return { kdk: pick(v.pickByLineStats), storage: pick(v.pieceSelectionStats) }
}

export function fmt(v) {
  if (v === null || v === undefined || v === '') return ''
  const n = Number(v)
  if (!Number.isFinite(n)) return ''
  return n.toLocaleString('ru-RU')
}

export function fmtPct(done, total) {
  if (!total) return '—'
  return Math.round(done / total * 100) + '%'
}

export const MANUAL_DEFAULTS = {
  shiftTotal: '',
  shipPlan: '', shipPrepared: '', shipShipped: '', shipInProgress: '', shipDelay: '',
  rkTotal: '',
  rcpKdkPlan: '', rcpStorPlan: '',
}

export function loadManual(dateStr) {
  try { return { ...MANUAL_DEFAULTS, ...JSON.parse(localStorage.getItem(`hr_manual_${dateStr}`) ?? '{}') } }
  catch { return { ...MANUAL_DEFAULTS } }
}

export const DEFAULT_PROC_NAMES = ['Кросс-докинг', 'Хранение']
export const FIXED_PROC_NAMES = new Set(DEFAULT_PROC_NAMES)

export function loadProcData(dateStr) {
  try { return JSON.parse(localStorage.getItem(`hr_proc_${dateStr}`) ?? '{}') }
  catch { return {} }
}

/** Разбор /api/date/:date/summary в почасовые строки — 1:1 с оригиналом,
 * включая reconciliation-строку "21:00" (только если она уже наступила по
 * МСК или дата в прошлом, и только если WMS-показатель отборки (picking)
 * выше того, что уже видно в почасовых строках). */
export function buildHourlyRows(summary, picking, dateStr) {
  if (!Array.isArray(summary?.hourly)) return []
  const byHour = new Map()
  for (const h of summary.hourly) byHour.set(h.hour, h)

  const BLOCK_HOURS = [21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8]
  let blkKdk = 0, blkStor = 0, blkEmpl = 0, blkDone = 0
  for (const h of BLOCK_HOURS) {
    const hd = byHour.get(h)
    if (!hd) continue
    blkKdk += hd.kdkOps
    blkStor += hd.ops - hd.kdkOps
    blkDone += hd.ops
    blkEmpl = Math.max(blkEmpl, hd.employeesKompl ?? hd.employees)
  }

  const rows = [{
    time: '00:00 - 9:00',
    kdk: blkKdk > 0 ? blkKdk : null,
    stor: blkStor > 0 ? blkStor : null,
    sotrud: blkEmpl > 0 ? blkEmpl : null,
    done: blkDone,
    avg: blkEmpl > 0 ? Math.round(blkDone / blkEmpl) : 0,
    kdkEmp: null, storageEmp: null,
  }]

  const INDIVIDUAL_HOURS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
  for (const h of INDIVIDUAL_HOURS) {
    const hd = byHour.get(h - 1)
    if (!hd || hd.ops === 0) {
      rows.push({ time: `${String(h).padStart(2, '0')}:00`, kdk: null, stor: null, sotrud: null, done: 0, avg: 0, kdkEmp: null, storageEmp: null })
      continue
    }
    const kdk = hd.kdkOps
    const stor = hd.ops - hd.kdkOps
    const done = hd.ops
    const empl = hd.employeesKompl ?? hd.employees
    rows.push({
      time: `${String(h).padStart(2, '0')}:00`,
      kdk: kdk > 0 ? kdk : null,
      stor: stor > 0 ? stor : null,
      sotrud: empl > 0 ? empl : null,
      done,
      avg: empl > 0 ? Math.round(done / empl) : 0,
      kdkEmp: (hd.kdkEmployees ?? 0) > 0 ? hd.kdkEmployees : null,
      storageEmp: (hd.storageEmployees ?? 0) > 0 ? hd.storageEmployees : null,
    })
  }

  // Reconciliation: строка "21:00" — только если уже наступило (МСК ≥ 21:00)
  // или смотрим прошлую дату, и только если WMS-показатель отборки выше
  // того, что уже сошлось в почасовых строках.
  const moscowHourNow = new Date(Date.now() + 3 * 60 * 60 * 1000).getUTCHours()
  const isPastDate = dateStr < todayStr()
  const show21 = isPastDate || moscowHourNow >= 21

  const wmsKdk = picking?.kdk?.done ?? 0
  const wmsStor = picking?.storage?.done ?? 0
  let sumKdk = blkKdk, sumStor = blkStor
  for (const r of rows) { sumKdk += r.kdk ?? 0; sumStor += r.stor ?? 0 }
  const adjKdk = wmsKdk - sumKdk
  const adjStor = wmsStor - sumStor
  if (show21 && (adjKdk > 0 || adjStor > 0)) {
    const hd21 = byHour.get(20)
    const empl = hd21 ? (hd21.employeesKompl ?? hd21.employees ?? 0) : 0
    const newDone = (adjKdk > 0 ? adjKdk : 0) + (adjStor > 0 ? adjStor : 0)
    rows.push({
      time: '21:00',
      kdk: adjKdk > 0 ? adjKdk : null,
      stor: adjStor > 0 ? adjStor : null,
      sotrud: empl > 0 ? empl : null,
      done: newDone,
      avg: empl > 0 ? Math.round(newDone / empl) : 0,
      kdkEmp: null, storageEmp: null,
    })
  }

  return rows
}

/** Статистика РК из маршрутов: за последний "активный" час и суммарно за сутки. */
export function calcRkStats(routes) {
  const byHour = new Map()
  for (const route of routes) {
    const recv = route.receiving
    if (!recv?.at) continue
    const totalRk = (recv.items || []).reduce((s, it) => s + (Number(it.rk) || 0), 0)
    if (totalRk === 0) continue
    const h = new Date(new Date(recv.at).getTime() + 3 * 3600 * 1000).getUTCHours()
    const cur = byHour.get(h) || { tc: 0, rk: 0 }
    cur.tc++
    cur.rk += totalRk
    byHour.set(h, cur)
  }
  const deliveredRK = [...byHour.values()].reduce((s, v) => s + v.rk, 0)
  const hours = [...byHour.keys()].sort((a, b) => a - b)
  const last = hours.length ? byHour.get(hours[hours.length - 1]) : null
  return { perHourTC: last?.tc ?? 0, perHourRK: last?.rk ?? 0, deliveredRK }
}
