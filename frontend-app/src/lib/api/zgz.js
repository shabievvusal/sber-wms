// «Поиск потеряшек» (переводы ЕО в ЗГЗ, найденные ЕО) и справочник ячеек → ЦФЗ.
import { req } from './core.js'

// Ячейки и ЦФЗ (справочник по зонам из WMS: id ячейки, магазин)
export async function getCellStores() {
  return req('/api/cell-stores')
}

export async function syncCellStores(zoneId, zoneName, cells) {
  return req('/api/cell-stores/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zoneId, zoneName, cells }),
  })
}

export async function deleteCellStoreZone(zoneId) {
  return req('/api/cell-stores/delete-zone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zoneId }),
  })
}

// «Поиск потеряшек» — переводы ЕО в ЗГЗ на сервере
export async function getZgzMoves(from, to) {
  return req(`/api/zgz/moves?${new URLSearchParams({ from, to })}`)
}

export async function getZgzInfo() {
  return req('/api/zgz/info')
}

export async function getZgzCount(dateFrom, dateTo) {
  const params = new URLSearchParams()
  if (dateFrom) params.set('dateFrom', dateFrom)
  if (dateTo) params.set('dateTo', dateTo)
  return req(`/api/zgz/count?${params}`)
}

// журнал найденных ЕО («Нашли» на карточке ЕО)
export async function addZgzFound(row) {
  return req('/api/zgz/found', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row) })
}

export async function getZgzFound(from, to) {
  return req(`/api/zgz/found?${new URLSearchParams({ from, to })}`)
}

export async function deleteZgzFound(id) {
  return req('/api/zgz/found/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
}

export async function deleteZgz(dateFrom, dateTo) {
  return req('/api/zgz/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dateFrom: dateFrom || null, dateTo: dateTo || null }),
  })
}
