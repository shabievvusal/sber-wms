// «Поиск потеряшек»: переводы ЕО в ЗГЗ и ячейки зоны с ЦФЗ (topology).
import { _buildBodyForBrowser, _fetchOnePageFromBrowser } from './stockChanges.js'
import { getStoredToken, postOwnBackend, wmsHeaders } from './core.js'

const TOPOLOGY_CELLS_FIND_URL = 'https://api.samokat.ru/wmsops-wwh/topology/v2/cells/find'

// stocks/changes, MOVE_TO_READY_ORDERS_ZONE: строка — товар в ЕО (ЕО одна и
// та же у источника и назначения), источник — ячейка КДК, назначение — ЗГЗ.
// За сутки — сотни тысяч строк: страницы по 2000, по 4 параллельно, строки
// сразу облегчаются (без картинок/сроков/остатков).
export async function fetchZgzMoves(token, { from, to, onProgress } = {}) {
  const size = 2000
  const body = pageNumber => ({
    ..._buildBodyForBrowser({ operationCompletedAtFrom: from, operationCompletedAtTo: to, pageNumber, pageSize: size }),
    operationTypes: ['MOVE_TO_READY_ORDERS_ZONE'],
  })
  const slim = it => ({
    id: it.id,
    hu: it.targetAddress?.handlingUnitBarcode || it.sourceAddress?.handlingUnitBarcode || '',
    sourceCell: it.sourceAddress?.cellAddress || '',
    targetCell: it.targetAddress?.cellAddress || '',
    productId: it.product?.productId || it.product?.nomenclatureCode || it.product?.name || '',
    name: it.product?.name || '',
    code: it.product?.nomenclatureCode || '',
    barcodes: it.product?.barcodes || [],
    qty: Math.max(0, (Number(it.targetQuantity?.newQuantity) || 0) - (Number(it.targetQuantity?.oldQuantity) || 0)) || 1,
    executorId: it.responsibleUser?.id || '',
    executor: [it.responsibleUser?.lastName, it.responsibleUser?.firstName, it.responsibleUser?.middleName].filter(Boolean).join(' '),
    completedAt: it.operationCompletedAt || null,
  })
  const first = await _fetchOnePageFromBrowser(token, body(1))
  let rows = first.items.map(slim)
  const total = first.total ?? rows.length
  const pages = Math.ceil(total / size)
  onProgress?.({ loaded: rows.length, total })
  const PARALLEL = 4
  for (let p = 2; p <= pages; p += PARALLEL) {
    const batch = Array.from({ length: Math.min(PARALLEL, pages - p + 1) }, (_, i) => p + i)
    // токен продлевается AuthContext'ом — берём свежий на каждую пачку
    const t = getStoredToken() || token
    const results = await Promise.all(batch.map(n => _fetchOnePageFromBrowser(t, body(n))))
    for (const r of results) rows = rows.concat(r.items.map(slim))
    onProgress?.({ loaded: rows.length, total })
  }
  return rows
}

// Загрузить переводы в ЗГЗ из WMS и сохранить на сервер (повторы строк
// отсекает сервер). Отправка частями — за сутки сотни тысяч строк, а лимит
// тела запроса у сервера 50 МБ.
export async function syncZgzFromWms(token, { from, to, onProgress } = {}) {
  const rows = await fetchZgzMoves(token, { from, to, onProgress: p => onProgress?.({ stage: 'wms', ...p }) })
  const CHUNK = 10000
  let added = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const res = await postOwnBackend('/api/zgz/save', { items: rows.slice(i, i + CHUNK) }, getStoredToken() || token, { wrap: false })
    if (res.ok !== true) throw new Error(res.error || 'Ошибка сохранения на сервер')
    added += res.added || 0
    onProgress?.({ stage: 'save', loaded: Math.min(i + CHUNK, rows.length), total: rows.length })
  }
  return { fetched: rows.length, added }
}

// У ячеек КДК storeName — магазин (ЦФЗ), под который в ячейке собирают заказы.
export async function fetchZoneCells(token, zoneId) {
  const size = 100
  const page = async pageNumber => {
    const r = await fetch(TOPOLOGY_CELLS_FIND_URL, {
      method: 'POST',
      headers: { ...wmsHeaders(token), 'Content-Type': 'application/json', 'X-Who': 'a3327d34-1f6b-46bb-9936-0306ec6c21ad' },
      body: JSON.stringify({
        filter: { cellAddressSearch: null, cellIds: [], zoneId, locationId: null, types: [], rows: [], sections: null, levels: [], numbers: null, statuses: [], operationTypes: [], withCategories: null, updatedAtFrom: null, updatedAtTo: null },
        pageNumber, pageSize: size, sortBy: 'CELL_ADDRESS', sortDirection: null,
      }),
    })
    if (!r.ok) throw new Error(`WMS cells/find ${r.status}`)
    const data = await r.json()
    return { items: data?.value?.items || [], total: data?.value?.total ?? 0 }
  }
  const first = await page(1)
  let items = [...first.items]
  for (let p = 2; p <= Math.ceil(first.total / size); p++) items = items.concat((await page(p)).items)
  return {
    zoneName: items[0]?.zone?.name || '',
    cells: items.map(c => ({ address: c.address, cellId: c.id || '', storeName: c.storeName || '' })),
  }
}
