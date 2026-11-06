// Журнал движений WMS (stocks/changes/search) постранично — общий для статистики, мониторинга, ЗГЗ, товаров и отчётов.
import { wmsHeaders } from './core.js'

const SAMOKAT_STOCKS_URL = 'https://api.samokat.ru/wmsops-wwh/stocks/changes/search'

export function _buildBodyForBrowser(options) {
  return {
    operationTypes: ['PICK_BY_LINE', 'PIECE_SELECTION_PICKING'],
    operationCompletedAtFrom: options.operationCompletedAtFrom,
    operationCompletedAtTo: options.operationCompletedAtTo,
    pageNumber: options.pageNumber || 1,
    pageSize: options.pageSize || 2000,
  }
}

// Только заданные фильтры, как шлёт сама WMS. С обновления WMS 05.11 (~13:45)
// пустые фильтры (`parts: []`, `productId: null`, …) отсекают всё: ответ 200 с
// пустым списком. Раньше тело было «полным шаблоном» с null — убрано.
function _onlySetFilters(body) {
  return Object.fromEntries(Object.entries(body).filter(([, v]) =>
    v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)))
}

export async function _fetchOnePageFromBrowser(token, body) {
  const r = await fetch(SAMOKAT_STOCKS_URL, {
    method: 'POST',
    headers: {
      ...wmsHeaders(token),
      'Content-Type': 'application/json',
      'X-Who': 'a3327d34-1f6b-46bb-9936-0306ec6c21ad',
    },
    body: JSON.stringify(_onlySetFilters(body)),
  })
  const text = await r.text()
  const trimmed = (text || '').trim().toLowerCase()
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    throw new Error('WMS вернул HTML вместо JSON. Проверьте VPN или доступ.')
  }
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error('Ответ не JSON: ' + (text || '').slice(0, 150))
  }
  if (!r.ok) throw new Error(`API ${r.status}: ${data?.message || data?.error || r.statusText}`)
  const value = data?.value || data
  const items = Array.isArray(value?.items) ? value.items : []
  const total = value?.total ?? data?.totalElements ?? null
  return { items, total }
}

// Все строки журнала за период, сырыми (как отдаёт WMS) — для сверки
// подсчётов. onProgress({ page, pages, rows }) — после каждой страницы.
export async function fetchAllStockChanges(token, { operationTypes, from, to, pageSize = 2000 }, onProgress) {
  const body = pageNumber => ({ operationTypes, operationCompletedAtFrom: from, operationCompletedAtTo: to, pageNumber, pageSize })
  const first = await _fetchOnePageFromBrowser(token, body(1))
  const pages = Math.max(1, Math.ceil((first.total ?? first.items.length) / pageSize))
  let rows = first.items
  onProgress?.({ page: 1, pages, rows: rows.length })
  for (let page = 2; page <= pages; page++) {
    const next = await _fetchOnePageFromBrowser(token, body(page))
    rows = rows.concat(next.items)
    onProgress?.({ page, pages, rows: rows.length })
  }
  return rows
}
