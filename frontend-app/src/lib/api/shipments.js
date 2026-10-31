// Отгрузка и приёмка РК: маршруты, водители, ЦФЗ, ЕО маршрута, фото; кио­ск кладовщика.
import { apiHeaders, credentials, req } from './core.js'

export async function getRkRoutes({ q, dateFrom, dateTo, receivedDateFrom, receivedDateTo, status } = {}) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (dateFrom) params.set('dateFrom', dateFrom)
  if (dateTo) params.set('dateTo', dateTo)
  if (receivedDateFrom) params.set('receivedDateFrom', receivedDateFrom)
  if (receivedDateTo) params.set('receivedDateTo', receivedDateTo)
  if (status) params.set('status', status)
  return req(`/api/rk/routes?${params}`)
}

export async function confirmRkShipment(routeId) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/confirm-ship`, { method: 'POST' })
}

export async function confirmRkReceiving(routeId) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/confirm-receive`, { method: 'POST' })
}

export async function deleteRkRoutesBulk(ids) {
  return req('/api/rk/routes/bulk', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
}

export async function getRkDrivers(q) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  return req(`/api/rk/drivers?${params}`)
}

export async function getRkCfz(q) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  return req(`/api/rk/cfz?${params}`)
}

export async function updateRkDriver(routeId, payload) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/driver`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function updateRkShipment(routeId, payload) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/ship`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function updateRkReceiving(routeId, payload) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/receive`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function deleteRkRoutesByDateRange(dateFrom, dateTo) {
  const params = new URLSearchParams({ dateFrom, dateTo })
  return req(`/api/rk/routes?${params}`, { method: 'DELETE' })
}

// fetchRkFromWms — намеренно НЕ реализуем здесь: требует настоящий токен браузерной
// сессии в wwh.samokat.ru.
// FetchModal ниже честно показывает это ограничение, а не притворяется, что скачал данные.
// searchRkRoutes/submitRkShipment/submitRkReceiving — POST-эндпоинты кладовщика
// (без сессии), не путать с updateRkShipment/updateRkReceiving выше (PUT,
// редактирование администратором из ShipmentsPage — это два разных реальных
// роута на бэкенде).

// `days` — окно в N последних календарных дней (сегодня + предыдущие).
// Шлёт только «Список ЕО» и только для списка по умолчанию: у него нет
// `mode`, который у отгрузки/приёмки сам собой оставляет незакрытые
// маршруты, поэтому без окна отдавались ВСЕ маршруты за всю историю.
export async function searchRkRoutes({ mode, q, days } = {}) {
  const params = new URLSearchParams()
  if (mode) params.set('mode', mode)
  if (q) params.set('q', q)
  if (days) params.set('days', days)
  return req(`/api/rk/routes-search?${params}`)
}

export async function getDriverRokhlyaDebt(name) {
  const params = new URLSearchParams({ name })
  return req(`/api/rk/driver-rokhlya-debt?${params}`)
}

export async function getRkRoute(routeId) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}`)
}

export async function getRouteEos(routeId) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/eos`)
}

export async function submitRkShipment(routeId, payload) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/ship`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function submitRkReceiving(routeId, payload) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/receive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

// Фото сжимаются в браузере (до 1280 px) — на сервер уходят сотни КБ, а не
// мегабайты с камеры телефона; dotnet только нормализует и делает превью.
export async function uploadRkPhotos(files) {
  const { compressImage } = await import('@/lib/compressImage')
  const form = new FormData()
  for (const f of files) form.append('photos', await compressImage(f))
  const r = await fetch('/api/rk/photos', { method: 'POST', credentials, headers: apiHeaders(), body: form })
  const data = await r.json().catch(() => null)
  if (!r.ok) throw new Error(data?.error || 'Ошибка загрузки фото')
  return data
}

// Маршруты, чьи ЕО имеет смысл обновить фоном (последние `days` дней) —
// только метаданные, без самих ЕО. Дёргает устройство с включённым
// автообновлением (eoAutoRefresh.jsx), а не экран кладовщика.
export async function getEoRefreshTargets(days, { warehouseId } = {}) {
  const params = new URLSearchParams()
  if (days) params.set('days', days)
  return req(`/api/rk/eo-refresh-targets?${params}`, warehouseId ? { headers: { 'X-Warehouse': warehouseId } } : {})
}

// Сохранение ЕО, полученных браузером напрямую из WMS (fetchRouteFromWMS в
// wmsFetch.js) — единственный путь их обновления. Ручной запрос «сходи в WMS
// за меня» (requestEoRefresh + очередь на бэкенде) убран 2026-09-06: списки
// обновляет фоном устройство с автообновлением (lib/eoAutoRefresh.jsx).
export async function saveRouteEosRefresh(routeId, wmsData, { warehouseId } = {}) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/eos/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(warehouseId ? { 'X-Warehouse': warehouseId } : {}) },
    body: JSON.stringify(wmsData),
  })
}
