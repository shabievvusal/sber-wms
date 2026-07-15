// Хелперы — перенесены из оригинала (MonitorPage.jsx + utils/format.js), но
// БЕЗ fio-based fallback/дедупа (normalizeFio/personKey/titleCase из
// оригинала): здесь связка между реестром сотрудников/переклички/живого
// снимка/задач — только по executorId, см. PLAN.md (решение от 2026-07-12).

export function formatDuration(ms) {
  if (!ms || ms < 0) return '—'
  const totalMin = Math.floor(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0) return `${h} ч ${m} мин`
  return `${m} мин`
}

export function formatTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
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

// Сырой ответ /api/monitor/live — это прозрачный проброс ответа WMS Самоката
// (наш бэкенд лишь пересылает его, не меняя форму), поэтому разбор нужен даже
// на «настоящем» пути, не только на моках. Ключ — executorId (u.id), не ФИО.
export function parseLiveData(data) {
  const result = new Map()
  const value = data?.value || data || {}
  const sections = [
    { key: 'pickByLineHandlingUnitsInProgress', type: 'КДК' },
    { key: 'pieceSelectionHandlingUnitsInProgress', type: 'ХР' },
    { key: 'palletSelectionHandlingUnitsInProgress', type: 'Паллет' },
  ]
  for (const { key, type } of sections) {
    for (const entry of value[key] || []) {
      const u = entry.user || {}
      const executorId = u.id
      if (!executorId) continue
      const displayFio = [u.lastName, u.firstName, u.middleName].filter(Boolean).join(' ')
      if (!result.has(executorId)) {
        result.set(executorId, { displayFio, taskType: type, startedAt: entry.startedAt || null })
      }
    }
  }
  return result
}

/** Вернуть дату и смену для текущего момента в московском времени (UTC+3).
 * Ночная смена: 21:00 дня D → 09:00 дня D+1.
 * После полуночи (00:00–08:59 МСК) текущая смена — ночная смена вчерашней даты. */
export function getCurrentShiftInfo() {
  const MOSCOW_MS = 3 * 60 * 60 * 1000
  const moscow = new Date(Date.now() + MOSCOW_MS)
  const h = moscow.getUTCHours()
  const todayMsk = moscow.toISOString().slice(0, 10)

  if (h >= 9 && h < 21) return { dateStr: todayMsk, shift: 'day' }
  if (h >= 21) return { dateStr: todayMsk, shift: 'night' }
  const prev = new Date(moscow.getTime() - 24 * 60 * 60 * 1000)
  return { dateStr: prev.toISOString().slice(0, 10), shift: 'night' }
}

/** Начало ТЕКУЩЕЙ смены как ISO-момент (для fetchLastCompletedForExecutor —
 * нужна не дата+смена лейблом, а точная граница диапазона). 09:00 МСК =
 * 06:00 UTC, 21:00 МСК = 18:00 UTC — 1-в-1 расчёт из оригинала. */
export function getShiftStartIso() {
  const MOSCOW_MS = 3 * 60 * 60 * 1000
  const now = new Date()
  const moscow = new Date(now.getTime() + MOSCOW_MS)
  const hMsk = moscow.getUTCHours()
  if (hMsk >= 9 && hMsk < 21) {
    const d = moscow.toISOString().slice(0, 10)
    return new Date(d + 'T06:00:00.000Z').toISOString()
  }
  const base = hMsk < 9 ? new Date(moscow.getTime() - 24 * 60 * 60 * 1000) : moscow
  const d = base.toISOString().slice(0, 10)
  return new Date(d + 'T18:00:00.000Z').toISOString()
}
