// Маршруты отгрузки РК и заказы на отгрузку из WMS.
import { apiHeaders } from '@/lib/api'
import { getWmsWarehouseId, samokatPost, wmsGet, wmsHeaders } from './core.js'

const WMS_ROUTES_BASE = 'https://api-p01.samokat.ru/wmsout-wwh/shipments/routes'

const SHIPMENT_ORDERS_URL = 'https://api-p01.samokat.ru/wmsout-wwh/shipment-order/shipments'

// Обновление ЕО по одному маршруту (CfzEoPanel.jsx) — своя реализация,
// не через wmsGet(): в оригинале у неё отдельный 20-секундный таймаут через
// AbortController (нет окружающей ретрай-логики, как у bulk-фетчей выше).
export async function fetchRouteFromWMS(token, routeId) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  let r
  try {
    r = await fetch(`${WMS_ROUTES_BASE}/${encodeURIComponent(routeId)}`, {
      method: 'GET',
      signal: controller.signal,
      headers: wmsHeaders(token),
    })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('WMS не ответил за 20 секунд. Проверьте интернет или попробуйте позже.')
    throw err
  } finally {
    clearTimeout(timer)
  }
  const text = await r.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error('Ответ не JSON: ' + (text || '').slice(0, 150))
  }
  if (!r.ok) throw new Error(`WMS HTTP ${r.status}: ${data?.message || data?.error || r.statusText}`)
  return data
}

// «Пропуски в отборе» (PickingGapsPage.jsx) — список заказов на отгрузку
// (склад «Хранение») и детали одного заказа с товарами. Тело POST-запроса
// подтверждено реальным запросом из DevTools (Copy as cURL), поля кроме
// перечисленных ниже в оригинале всегда null — не добавляем лишних
// параметров, которых не видели в реальном вызове.
export async function getShipmentOrders(token, {
  pageNumber = 1,
  pageSize = 100,
  shippedDateFrom,
  shippedDateTo,
  status,
  temperatureMode = null,
} = {}) {
  return samokatPost(token, SHIPMENT_ORDERS_URL, {
    shipmentNumber: null, orderId: null, shipmentType: null, routeNumber: null,
    shippedDateFrom, shippedDateTo, status,
    incompleteReservationsOnly: null, availableForCorrectionOnly: null,
    cityId: null, shipToId: null, temperatureMode,
    correctedOnly: null, pageNumber, pageSize,
  })
}

export async function getShipmentOrderDetail(token, id) {
  return wmsGet(`${SHIPMENT_ORDERS_URL}/${encodeURIComponent(id)}`, token)
}

export async function fetchRkFromWms({ dateFrom, dateTo, token, onProgress }) {
  const fromIso = new Date(dateFrom + 'T00:00:00+03:00').toISOString()
  const toIso = new Date(dateTo + 'T23:59:59+03:00').toISOString()

  function buildParams(pageNumber, pageSize) {
    const p = new URLSearchParams({ dateFrom: fromIso, dateTo: toIso, pageNumber, pageSize })
    p.append('status', 'PACKAGING')
    p.append('status', 'COMPLETED')
    return p
  }

  const pageSize = 100
  const firstData = await wmsGet(`${WMS_ROUTES_BASE}?${buildParams(1, pageSize)}`, token)
  const first = firstData?.value ?? firstData
  const total = first?.total || 0
  const rawItems = [...(first?.items || [])]
  const pages = Math.ceil(total / pageSize)
  for (let p = 2; p <= pages; p++) {
    const d = await wmsGet(`${WMS_ROUTES_BASE}?${buildParams(p, pageSize)}`, token)
    rawItems.push(...((d?.value ?? d)?.items || []))
  }
  const seen = new Set()
  const items = rawItems.filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true })

  onProgress?.(`Маршрутов: ${items.length}. Загружаю детали...`)

  const routeDetails = []
  const BATCH = 5
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH)
    const details = await Promise.all(
      batch.map(item => wmsGet(`${WMS_ROUTES_BASE}/${encodeURIComponent(item.id)}`, token).catch(e => ({ _error: e.message })))
    )
    for (const d of details) { if (!d._error) routeDetails.push(d) }
    onProgress?.(`Загружено деталей: ${routeDetails.length} / ${items.length}...`)
  }

  // маршруты — в склад, выбранный сейчас в WMS (откуда они и пришли)
  const wmsWarehouse = await getWmsWarehouseId(token).catch(() => null)
  const r = await fetch('/api/rk/import-bulk', {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json', ...(wmsWarehouse ? { 'X-Warehouse': wmsWarehouse } : {}) }),
    body: JSON.stringify({ routes: routeDetails }),
    credentials: 'include',
  })
  return r.json()
}
