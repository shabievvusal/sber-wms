// Статусы отгрузки ЕО. Источник — флаги WMS у каждой ЕО маршрута
// (stores[].handlingUnits[]): `movedToGate` — подвезена к воротам,
// `movedIntoVehicle` — загружена в машину. Бэкенд сохраняет их при каждом
// обновлении ЕО из WMS (parseStoreEos); у ЕО, сохранённых раньше, флагов нет
// (null) — это «нет данных» до ближайшего автообновления.
//
// ЦФЗ и маршрут в целом: «загружен» — загружены ВСЕ ЕО, «подвезён» — все ЕО
// на воротах (часть может быть ещё не загружена), иначе «не подвезён».
// Удалённые ЕО (removedEos) в статусах не участвуют.

export const EO_STAGES = {
  notMoved: { label: 'Не подвезено', variant: 'warning' },
  atGate: { label: 'Подвезено, не загружено', variant: 'info' },
  loaded: { label: 'Загружено', variant: 'success' },
  unknown: { label: 'Нет данных', variant: 'outline' },
}

// Порядок в списке: сначала то, что требует внимания.
const STAGE_ORDER = ['notMoved', 'atGate', 'loaded', 'unknown']

export function eoStage(eo) {
  if (eo?.movedIntoVehicle) return 'loaded'
  if (eo?.movedToGate) return 'atGate'
  if (eo?.movedToGate === false || eo?.movedIntoVehicle === false) return 'notMoved'
  return 'unknown'
}

export function sortByStage(eos) {
  return [...eos].sort((a, b) => STAGE_ORDER.indexOf(eoStage(a)) - STAGE_ORDER.indexOf(eoStage(b)))
}

/** `{ total, atGate, loaded, unknown }`; atGate включает уже загруженные. */
export function summarizeEos(eos) {
  const s = { total: 0, atGate: 0, loaded: 0, unknown: 0 }
  for (const eo of eos || []) {
    s.total += 1
    const stage = eoStage(eo)
    if (stage === 'unknown') s.unknown += 1
    if (stage === 'atGate' || stage === 'loaded') s.atGate += 1
    if (stage === 'loaded') s.loaded += 1
  }
  return s
}

const GROUP_VARIANTS = { loaded: 'success', atGate: 'info', notMoved: 'warning', unknown: 'outline' }
const ROUTE_LABELS = { loaded: 'Маршрут загружен', atGate: 'Маршрут подвезён', notMoved: 'Маршрут не подвезён', unknown: 'Статус неизвестен' }
const CFZ_LABELS = { loaded: 'Загружено', atGate: 'Подвезено', notMoved: 'Не подвезено', unknown: 'Нет данных' }

function groupKey(s) {
  if (s.unknown === s.total) return 'unknown'
  if (s.loaded === s.total) return 'loaded'
  if (s.atGate === s.total) return 'atGate'
  return 'notMoved'
}

/** Статус маршрута по сводке ЕО, `null` — ЕО нет. */
export function routeShipStatus(s) {
  if (!s.total) return null
  const key = groupKey(s)
  return { key, label: ROUTE_LABELS[key], variant: GROUP_VARIANTS[key] }
}

/** Короткий статус для строки ЦФЗ, `null` — ЕО нет. */
export function cfzShipStatus(s) {
  if (!s.total) return null
  const key = groupKey(s)
  const label = key === 'notMoved' ? `${CFZ_LABELS[key]}: ${s.total - s.atGate}` : CFZ_LABELS[key]
  return { key, label, variant: GROUP_VARIANTS[key] }
}
