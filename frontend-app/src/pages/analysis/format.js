// Хелперы и расчёты — перенесены из оригинала AnalysisPage.jsx один в один
// (чистая логика прогноза, не зависит от WMS), плюс (Трек 3, Фаза 6)
// shiftWindow/mskFrom/mskTo/parseMonitoringStats/parseLivePeople/pieceQty/
// TEMP_TO_ZONE — теперь нужны для реальных WMS-запросов, когда есть токен.

// Окно смены (18:00 UTC день-1 → 18:00 UTC день) для getReportMonitoringStats.
export function shiftWindow(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const from = new Date(Date.UTC(y, m - 1, d - 1, 18, 0, 0, 0))
  const to = new Date(Date.UTC(y, m - 1, d, 18, 0, 0, 0))
  return { from: from.toISOString(), to: to.toISOString() }
}

export function mskFrom(d) { return new Date(`${d}T00:00:00+03:00`).toISOString() }
export function mskTo(d) { return new Date(`${d}T23:59:59.999+03:00`).toISOString() }

export function pieceQty(val) {
  if (val == null) return 0
  if (typeof val === 'number') return val
  return val.pieceProducts ?? val.weightProducts ?? 0
}

// Температура → зона КДК-хранения. LOW_COLD маппится на 'KDM' — зону, для
// которой в оригинале НЕТ карточки (только KDS/KDH отображаются) — известный
// баг оригинала (мёртвая ветка: такие строки попадают в pickFcast.rows, но
// нигде не показываются и не учитываются), воспроизведён намеренно, не
// исправлен — см. PLAN.md.
export const TEMP_TO_ZONE = { ORDINARY: 'KDS', MEDIUM_COLD: 'KDH', LOW_COLD: 'KDM' }

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

export function parseLivePeople(data) {
  const v = data?.value || data || {}
  const sections = [
    { key: 'pickByLineHandlingUnitsInProgress', type: 'kdk' },
    { key: 'pieceSelectionHandlingUnitsInProgress', type: 'storage' },
  ]
  const counts = { kdk: 0, storage: 0 }
  const seen = new Set()
  for (const { key, type } of sections) {
    for (const entry of (v[key] || [])) {
      const u = entry.user || {}
      const fio = [u.lastName, u.firstName].filter(Boolean).join(' ')
      if (!fio) continue
      const uid = fio + type
      if (seen.has(uid)) continue
      seen.add(uid)
      counts[type]++
    }
  }
  return counts
}

export function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

export function fmt(v) {
  if (v == null) return '—'
  return Number(v).toLocaleString('ru-RU')
}

export function fmtTime(date) {
  if (!date) return '—'
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

export function buildSpeedMap(results) {
  const map = new Map()
  for (const r of results || []) {
    if (r.qtyPerPersonHour > 0 && r.nomenclatureCode) {
      const key = `${r.nomenclatureCode}:${r.zone}`
      const prev = map.get(key)
      if (!prev || r.totalOps > prev.totalOps) map.set(key, r)
    }
  }
  return map
}

/** Прогноз по остатку человеко-часов (комплектация КДК: personHours уже известен). */
export function calcForecastPH(personHours, people, shiftEnd) {
  if (!personHours || !people || people <= 0 || !shiftEnd) return null
  const projFinish = new Date(Date.now() + personHours / people * 3_600_000)
  const minDiff = Math.round((shiftEnd - projFinish) / 60_000)
  const status = minDiff >= 30 ? 'ok' : minDiff >= 0 ? 'warn' : 'over'
  return { projFinish, status, minDiff }
}

/** Прогноз по остатку задач + скорости (хранение: rest напрямую, без personHours). */
export function calcForecastTasks(rest, people, speed, shiftEnd) {
  if (!rest || !people || !speed || people <= 0 || speed <= 0 || !shiftEnd) return null
  const projFinish = new Date(Date.now() + rest / (people * speed) * 3_600_000)
  const minDiff = Math.round((shiftEnd - projFinish) / 60_000)
  const status = minDiff >= 30 ? 'ok' : minDiff >= 0 ? 'warn' : 'over'
  return { projFinish, status, minDiff }
}

export function loadOverrides() {
  try { const v = localStorage.getItem('analysis_overrides'); return v ? JSON.parse(v) : {} } catch { return {} }
}
export function saveOverrides(val) {
  try { localStorage.setItem('analysis_overrides', JSON.stringify(val)) } catch { /* ignore */ }
}

export function calcAvgSpeed(rows, lastN = 3) {
  if (!rows?.length) return null
  const nonZero = rows.filter(r => r.avg > 0 && r.sotrud > 0)
  const recent = nonZero.slice(-lastN)
  if (!recent.length) return null
  return Math.round(recent.reduce((s, r) => s + r.avg, 0) / recent.length)
}

/** Часовые бэкенд-строки → ряды 10:00-21:00 для таблицы «Почасовая динамика».
 * Тот же сдвиг (строка H:00 читает бэкенд-час H-1), что и в HourlyReport, но
 * без ночного блока и без reconciliation-строки — в AnalysisPage их не было. */
export function buildAnalysisHourlyRows(summary) {
  if (!Array.isArray(summary?.hourly)) return []
  const byHour = new Map()
  for (const h of summary.hourly) byHour.set(h.hour, h)
  const HOURS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]
  return HOURS.map(h => {
    const hd = byHour.get(h - 1)
    if (!hd || hd.ops === 0) return null
    const kdk = hd.kdkOps
    const stor = hd.ops - hd.kdkOps
    const empl = hd.employeesKompl ?? hd.employees ?? 0
    return {
      time: `${String(h).padStart(2, '0')}:00`,
      kdk: kdk > 0 ? kdk : null,
      stor: stor > 0 ? stor : null,
      sotrud: empl > 0 ? empl : null,
      done: hd.ops,
      avg: empl > 0 ? Math.round(hd.ops / empl) : 0,
    }
  }).filter(Boolean)
}
