// Перенесено из оригинала (frontend/app/src/pages/stats/StatsPage.jsx +
// utils/statsCalc.js) — форматтеры и «часовая» математика главной страницы.
// Полный клиентский пересчёт статистики из сырых items (statsCalc.js) НЕ
// перенесён — как и в уже перенесённых ReportsPage/AnalysisPage, здесь
// потребляется только уже готовый агрегированный ответ бэкенда
// (getDateSummaryFull), а не дублируется его серверная логика на клиенте
// (см. PLAN.md про statsCalc.js/storage.js).

import { DAY_HOURS, NIGHT_HOURS, SHIFT_MINUTES } from './constants'

/** KD*-зоны — кросс-док/пик-бай-лайн (КДК), обычные H-зоны — хранение. */
export function isKdkZoneKey(zoneKey) {
  return String(zoneKey || '').toUpperCase().startsWith('KD')
}

// ─── Зоны комплектации — без хардкода списка зон ───────────────────────────
// Оригинал держит фиксированный массив из 6 зон (utils/statsCalc.js: ZONES).
// По прямому указанию пользователя (2026-07-12: «без хардкода добавлять
// новые зоны, название и цвета») здесь вместо этого — известные подписи как
// подсказки для уже знакомых ключей + детерминированная по хэшу палитра,
// работающая для ЛЮБОГО ключа зоны, который реально встретится в данных.
// Список зон для легенды/фильтра всегда собирается из фактических данных
// (`collectZoneKeys`/`buildZoneCatalog`), а не из статичного перечня — новая
// зона на бэкенде появится в интерфейсе сама, без правки кода.
//
// Уточнение (2026-07-12): администратор/разработчик может добавлять новые
// зоны и переопределять название/цвет прямо на сайте (Настройки → Система →
// «Зоны комплектации»), без похода в код — переопределения лежат в
// localStorage (`stats_zone_overrides`) и имеют приоритет над известными
// подписями/хэш-палитрой ниже.

const LS_ZONE_OVERRIDES = 'stats_zone_overrides'

function readZoneOverrides() {
  try { return JSON.parse(localStorage.getItem(LS_ZONE_OVERRIDES) || '{}') } catch { return {} }
}

export function getZoneOverrides() {
  return readZoneOverrides()
}

export function saveZoneOverride(key, { label, light, text }) {
  const overrides = readZoneOverrides()
  overrides[key] = { label, light, text }
  try { localStorage.setItem(LS_ZONE_OVERRIDES, JSON.stringify(overrides)) } catch { /* ignore */ }
}

export function deleteZoneOverride(key) {
  const overrides = readZoneOverrides()
  delete overrides[key]
  try { localStorage.setItem(LS_ZONE_OVERRIDES, JSON.stringify(overrides)) } catch { /* ignore */ }
}

/** Ключи зон, для которых есть ручное переопределение — показываются в
 * фильтрах даже если ещё ни разу не встретились в загруженных данных. */
export function getRegisteredZoneKeys() {
  return Object.keys(readZoneOverrides()).sort()
}

const KNOWN_ZONE_LABELS = {
  HH: 'Хол. хранение', KDH: 'КДК холод', SH: 'Сух. хранение',
  KDS: 'КДК сухой', MH: 'Хр. заморозка', KDM: 'КДК заморозка',
}

/** Человекочитаемая подпись зоны — переопределение, известная подсказка,
 * иначе сам ключ. */
export function zoneLabel(key) {
  const override = readZoneOverrides()[key]
  if (override?.label) return override.label
  return KNOWN_ZONE_LABELS[key] || key
}

// Точные цвета оригинала (utils/statsCalc.js: ZONES) для 6 известных
// ключей — используются напрямую, а не через хэш-подбор (хэш не
// гарантирует, что «HH» попадёт именно на исходный синий и т.д.). Это те же
// значения, что раньше жили в захардкоженном массиве ZONES — разница в том,
// что это словарь известных ЗНАЧЕНИЙ ПО УМОЛЧАНИЮ для знакомых ключей, а не
// исчерпывающий список поддерживаемых зон: новый ключ, которого здесь нет,
// всё равно получает цвет через хэш-палитру ниже, без правки кода.
const KNOWN_ZONE_COLORS = {
  HH: { light: '#1d4ed8', text: '#fff' },
  KDH: { light: '#93c5fd', text: '#1e3a5f' },
  SH: { light: '#c2410c', text: '#fff' },
  KDS: { light: '#fdba74', text: '#7c2d12' },
  MH: { light: '#6d28d9', text: '#fff' },
  KDM: { light: '#c4b5fd', text: '#3b0764' },
}

// Хэш-палитра — только для зон, которых нет ни в KNOWN_ZONE_COLORS, ни в
// переопределениях (т.е. по-настоящему новых ключей).
const ZONE_COLOR_PALETTE = [
  { light: '#0f766e', text: '#fff' },
  { light: '#5eead4', text: '#134e4a' },
  { light: '#a21caf', text: '#fff' },
  { light: '#f0abfc', text: '#701a75' },
  { light: '#4d7c0f', text: '#fff' },
  { light: '#bef264', text: '#365314' },
]

function hashString(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

/** Читаемый цвет текста (чёрный/белый) по относительной яркости фона —
 * используется в карточке настроек, чтобы не просить второй цвет у админа. */
export function pickTextColor(bgHex) {
  const hex = String(bgHex || '').replace('#', '')
  if (hex.length !== 6) return '#000'
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > 0.55 ? '#000' : '#fff'
}

/** Цвет зоны — переопределение, иначе точный цвет оригинала для знакомого
 * ключа, иначе детерминирован по ключу (хэш) для по-настоящему новых зон —
 * в любом случае один и тот же ключ всегда получает один и тот же цвет. */
export function zoneColor(key) {
  const override = readZoneOverrides()[key]
  if (override?.light) return { light: override.light, text: override.text || pickTextColor(override.light) }
  if (KNOWN_ZONE_COLORS[key]) return KNOWN_ZONE_COLORS[key]
  return ZONE_COLOR_PALETTE[hashString(String(key)) % ZONE_COLOR_PALETTE.length]
}

/** Реально встретившиеся ключи зон в строках (byHourZone/byZone), отсортированы. */
export function collectZoneKeys(rows) {
  const set = new Set()
  for (const r of rows || []) {
    for (const k of Object.values(r.byHourZone || {})) if (k) set.add(k)
    for (const k of Object.keys(r.byZone || {})) set.add(k)
  }
  return [...set].sort()
}

/** Полный каталог зон, реально присутствующих в данных: {key, label, light, text}. */
export function buildZoneCatalog(rows) {
  return collectZoneKeys(rows).map(key => ({ key, label: zoneLabel(key), ...zoneColor(key) }))
}

/** То же самое, но плюс вручную зарегистрированные зоны (Настройки), даже
 * если они ещё ни разу не встретились в данных — для выпадающих фильтров
 * (например, «За период»), где нужно выбрать зону ДО загрузки данных. */
export function buildFullZoneCatalog(rows) {
  const keys = new Set([...collectZoneKeys(rows), ...getRegisteredZoneKeys()])
  return [...keys].sort().map(key => ({ key, label: zoneLabel(key), ...zoneColor(key) }))
}

export function fmtNum(n) {
  if (n === null || n === undefined || n === '') return '—'
  const num = Number(n)
  return Number.isFinite(num) ? num.toLocaleString('ru-RU') : String(n)
}

export function fmtWeight(grams) {
  const g = Number(grams) || 0
  if (g <= 0) return '—'
  if (g >= 1_000_000) return (g / 1_000_000).toFixed(2) + ' т'
  if (g >= 1_000) return (g / 1_000).toFixed(1) + ' кг'
  return Math.round(g) + ' г'
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

/** Дата и смена для текущего момента в московском времени (UTC+3).
 * Ночная смена: 21:00 дня D → 09:00 дня D+1. */
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

export function getShiftHours(shift) {
  return shift === 'night' ? NIGHT_HOURS : DAY_HOURS
}

/** Час-бакет (`col = hour+1`) → реальный час завершения операции. */
export function actualHourFromCol(col) {
  return (col - 1 + 24) % 24
}

/** Бакет 10 → «09–10» и т.д. — дословно как `hourLabel()` оригинала
 * (HourlyEmployeeTable.jsx), используется как title-тултип на заголовке
 * часовой колонки (сама колонка показывает голое число бакета). */
export function hourRangeLabel(col) {
  const start = actualHourFromCol(col)
  return `${String(start).padStart(2, '0')}–${String(col).padStart(2, '0')}`
}

/** Сколько часов смены уже прошло (включая текущий) — для «сегодня» считает
 * по реальному московскому времени, для прошлых дат — вся смена (12ч). */
export function getHoursPassedIncludingCurrent(dateStr, shift) {
  const { dateStr: todayStr } = getCurrentShiftInfo()
  if (dateStr !== todayStr) return 12
  const MOSCOW_MS = 3 * 60 * 60 * 1000
  const moscow = new Date(Date.now() + MOSCOW_MS)
  const h = moscow.getUTCHours()
  const m = moscow.getUTCMinutes()
  const hoursFrom = start => Math.max(1, Math.min(12, Math.ceil(((h - start + 24) % 24) + m / 60)))
  return shift === 'night' ? hoursFrom(21) : hoursFrom(9)
}

export function calcRate(total, employees, hoursPassed) {
  if (!employees || !hoursPassed) return 0
  return Math.round(total / employees / hoursPassed)
}

/** Сколько минут смены уже прошло (для «сегодня» — реальное время, для
 * прошлых дат — вся смена, 720 мин) — знаменатель для
 * computeWorkedMinutesInShift (оригинал: statsCalc.js, getElapsedShiftMinutes). */
export function getElapsedShiftMinutes(dateStr, shift) {
  const { dateStr: todayStr } = getCurrentShiftInfo()
  if (dateStr !== todayStr) return SHIFT_MINUTES
  const MOSCOW_MS = 3 * 60 * 60 * 1000
  const moscow = new Date(Date.now() + MOSCOW_MS)
  const h = moscow.getUTCHours()
  const m = moscow.getUTCMinutes()
  const startHour = shift === 'night' ? 21 : 9
  const elapsed = ((h - startHour + 24) % 24) * 60 + m
  return Math.max(0, Math.min(SHIFT_MINUTES, elapsed))
}

/** Разрешённые минуты простоя вычитаются из простоя ДО расчёта отработанного
 * времени — «первые N минут простоя не считаются». */
export function computeWorkedMinutesInShift(idleMin, allowedIdleMinutes, shiftMinutes = SHIFT_MINUTES) {
  return Math.max(0, shiftMinutes - Math.max(0, (idleMin || 0) - (allowedIdleMinutes || 0)))
}

const IDLE_RE = /(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/g

export function parseIdleTotalMinutes(intervals) {
  if (!intervals) return 0
  let total = 0
  for (const m of String(intervals).matchAll(IDLE_RE)) {
    const fromMin = Number(m[1]) * 60 + Number(m[2])
    const toMin = Number(m[3]) * 60 + Number(m[4])
    total += toMin >= fromMin ? toMin - fromMin : (24 * 60 - fromMin) + toMin
  }
  return total
}

/** Переводит "HH:MM–HH:MM" в позицию на 12-часовой (720мин) шкале смены,
 * относительно её начала (день: 09:00=0, ночь: 21:00=0, с переходом через полночь). */
export function parseIdleIntervalsForTimeline(intervals, shift) {
  if (!intervals) return []
  const shiftStartMin = shift === 'night' ? 21 * 60 : 9 * 60
  const toRel = absMin => ((absMin - shiftStartMin + 24 * 60) % (24 * 60))
  const out = []
  for (const m of String(intervals).matchAll(IDLE_RE)) {
    const fromAbs = Number(m[1]) * 60 + Number(m[2])
    const toAbs = Number(m[3]) * 60 + Number(m[4])
    const relFrom = toRel(fromAbs)
    let relTo = toRel(toAbs)
    if (relTo <= relFrom) relTo = SHIFT_MINUTES
    out.push({
      leftPct: Math.max(0, Math.min(100, (relFrom / SHIFT_MINUTES) * 100)),
      widthPct: Math.max(0.5, Math.min(100, ((relTo - relFrom) / SHIFT_MINUTES) * 100)),
      minutes: relTo - relFrom,
    })
  }
  return out
}
