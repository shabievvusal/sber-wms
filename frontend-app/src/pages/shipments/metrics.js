// Переключатель показателя для колонок «отгр./принято/разница» — вместо того
// чтобы держать РК, паллеты, ящики и ТЧ одновременно четырьмя парами колонок,
// таблица показывает одну пару и переключается между видами тары. Общий модуль,
// а не часть ShipmentsPage.jsx — используется и там, и в AggregateView.jsx
// (вкладки «По водителям»/«По ЦФЗ»), импорт из компонента страницы в компонент
// страницы создал бы циклическую зависимость.
//
// Поля агрегатов (по водителю/по ЦФЗ) называются иначе, чем у самих маршрутов
// (shippedTotal/receivedTotal вместо shippedRK/receivedRK) — отсюда agg*Field.
export const METRICS = [
  { key: 'rk', label: 'РК', shippedField: 'shippedRK', receivedField: 'receivedRK', aggShippedField: 'shippedTotal', aggReceivedField: 'receivedTotal' },
  { key: 'pallets', label: 'Пал.', shippedField: 'shippedPallets', receivedField: 'receivedPallets', aggShippedField: 'shippedPallets', aggReceivedField: 'receivedPallets' },
  { key: 'boxes', label: 'Ящ.', shippedField: 'shippedBoxes', receivedField: 'receivedBoxes', aggShippedField: 'shippedBoxes', aggReceivedField: 'receivedBoxes' },
  { key: 'thermalCovers', label: 'ТЧ', shippedField: 'shippedThermalCovers', receivedField: 'receivedThermalCovers', aggShippedField: 'shippedThermalCovers', aggReceivedField: 'receivedThermalCovers' },
]

/** Разница для строки маршрута по выбранному показателю. */
export function metricDiff(route, metric) {
  if (metric.key === 'rk') return route.diff
  const s = route[metric.shippedField]
  const v = route[metric.receivedField]
  if (s == null && v == null) return null
  return (v || 0) - (s || 0)
}

/** То же самое, но для строк агрегатов (по водителю/по ЦФЗ) — поля с другими именами. */
export function metricAggDiff(row, metric) {
  if (metric.key === 'rk') return row.diff
  const s = row[metric.aggShippedField]
  const v = row[metric.aggReceivedField]
  if (s == null && v == null) return null
  return (v || 0) - (s || 0)
}
