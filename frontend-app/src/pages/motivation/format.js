// Мотивация аутсорса — вспомогательные функции страницы (MotivationPage.jsx).

export { fmtNum, todayStr } from '../shift-plan/format'

export const SHIFT_LABELS = { day: 'День', night: 'Ночь' }

export const ROLE_LABELS = { picker: 'Комплектовщик', other: 'Без нормы (грузчик и т.п.)' }

// status → [подпись, вариант Badge]; коды — MotivationStatuses в
// backend-dotnet/Models/MotivationModels.cs.
export const STATUS_META = {
  done: ['Полные часы', 'success'],
  under: ['Недобор', 'warning'],
  over: ['Перевыполнение', 'info'],
  no_account: ['Нет учётки', 'destructive'],
  late: ['Учётка после срока', 'destructive'],
  no_stats: ['Нет в статистике', 'destructive'],
  no_norm: ['Без нормы', 'secondary'],
}

export function currentShift() {
  const h = new Date().getHours()
  return h >= 9 && h < 21 ? 'day' : 'night'
}

// Ночная смена начинается в день D и заканчивается утром D+1 — если по
// ночной смене учётку получили до полудня, это уже следующая дата.
export function toReceivedIso(date, shift, time) {
  if (!time) return null
  let d = date
  if (shift === 'night' && time < '12:00') {
    const [y, m, day] = date.split('-').map(Number)
    const next = new Date(Date.UTC(y, m - 1, day + 1))
    d = next.toISOString().slice(0, 10)
  }
  return `${d}T${time}:00+03:00`
}

export function nowTimeStr() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function fmtTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })
}

export function fmtDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
  })
}

export function fmtPct(v) {
  if (v == null) return '—'
  return `${Math.round(v * 100)}%`
}

export function fmtHours(v) {
  const n = Number(v) || 0
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 1 })
}

const normName = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase()

// Справочник учёток: executorId и ФИО учётки (как в WMS) → запись сотрудника.
export function buildAccountIndex(employees) {
  const byId = new Map()
  const byName = new Map()
  for (const e of employees || []) {
    if (!e.executorId) continue
    byId.set(String(e.executorId).trim(), e)
    const key = normName(e.fio)
    if (!key) continue
    // Одинаковые ФИО у разных учёток — по имени однозначно не определить.
    byName.set(key, byName.has(key) ? null : e)
  }
  return { byId, byName }
}

// Текст учётки (ID или ФИО учётки) → { executorId, executorName, matched }.
export function resolveAccount(text, index) {
  const raw = String(text || '').trim()
  if (!raw) return { executorId: '', executorName: '', matched: true }
  const byId = index.byId.get(raw)
  if (byId) return { executorId: byId.executorId, executorName: byId.fio, matched: true }
  const byName = index.byName.get(normName(raw))
  if (byName) return { executorId: byName.executorId, executorName: byName.fio, matched: true }
  return { executorId: '', executorName: raw, matched: false }
}

const OTHER_ROLE_WORDS = ['грузчик', 'заморозк', 'другое', 'без нормы', 'other']

// Вставка из таблицы/мессенджера: по строке на человека —
// «ФИО <разделитель> учётка [<разделитель> роль]». Разделитель — табуляция,
// «;» или тире с пробелами. Учётка может отсутствовать (тогда «нет учётки»).
export function parsePeopleText(text, index) {
  const rows = []
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split(/\t|;|\s[-–—]\s/).map(s => s.trim())
    const fio = parts[0].replace(/^\d+[.)]\s*/, '')
    if (!fio) continue
    const roleText = (parts[2] || '').toLowerCase()
    const role = OTHER_ROLE_WORDS.some(w => roleText.includes(w)) ? 'other' : 'picker'
    rows.push({ fio, role, accountText: parts[1] || '', ...resolveAccount(parts[1], index) })
  }
  return rows
}
