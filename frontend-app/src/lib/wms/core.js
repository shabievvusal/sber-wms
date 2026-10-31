// Общее для запросов в WMS: токен из браузера, заголовки, GET/POST в api.samokat.ru, склад учётки в WMS и запись выгрузки в свой бэкенд.
import { apiHeaders } from '@/lib/api'

// склад, выбранный сейчас в WMS у учётки (у учётки он один на все её сессии)
const WMS_FEATURES_URL = 'https://api.samokat.ru/wmsops-wwh/warehouses/features-configuration'

const WMS_SHIFTS_URL = 'https://api.samokat.ru/wmsin-wwh/shifts'

const LS_ACCESS_KEY = 'wms_access_token'

const LS_ACCESS_EXPIRY_KEY = 'wms_access_token_expiry'

// Общий геттер токена — раньше был задублирован в FetchModal.jsx, вынесен
// сюда (единственная разница с дублем: теперь один источник истины для
// всех потребителей wmsFetch.js).
export function getStoredToken() {
  const token = localStorage.getItem(LS_ACCESS_KEY)
  const expiry = localStorage.getItem(LS_ACCESS_EXPIRY_KEY)
  if (!token) return null
  if (expiry && Date.now() > Number(expiry) - 60000) return null
  return token
}

export function wmsHeaders(token) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    Origin: 'https://wwh.samokat.ru',
    Referer: 'https://wwh.samokat.ru/',
  }
}

export async function wmsGet(url, token) {
  const r = await fetch(url, { headers: wmsHeaders(token) })
  const text = await r.text()
  const trimmed = (text || '').trim().toLowerCase()
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    throw new Error('WMS вернул HTML — токен устарел. Обновите страницу и войдите заново.')
  }
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error('WMS вернул не JSON: ' + (text || '').slice(0, 150))
  }
  if (!r.ok) throw new Error(`WMS ${r.status}: ${data?.message || data?.error || r.statusText}`)
  return data
}

// Данные из WMS приходят по складу, выбранному сейчас у учётки (в шапке WMS;
// он один на все сессии учётки). Поэтому всё, что сохраняется у нас,
// помечается именно этим складом — а не выбранным на сайте: иначе данные
// одного склада попали бы в другой.
let wmsWarehouseCache = { token: null, id: null, at: 0 }

/** id склада, выбранного сейчас в WMS у учётки токена (кэш 1 мин). */
export async function getWmsWarehouseId(token, { fresh = false } = {}) {
  if (!token) return null
  if (!fresh && wmsWarehouseCache.token === token && Date.now() - wmsWarehouseCache.at < 60_000) return wmsWarehouseCache.id
  const data = await wmsGet(WMS_FEATURES_URL, token)
  const id = data?.value?.warehouseId || null
  wmsWarehouseCache = { token, id, at: Date.now() }
  return id
}

/** Сменить склад в WMS — как выбор склада в шапке WMS: склад в WMS — это
 *  открытая смена, поэтому текущая закрывается (shifts/close) и открывается
 *  новая на нужном складе (shifts). Меняется во всех сессиях учётки — только
 *  по явному нажатию пользователя. */
export async function switchWmsWarehouse(token, warehouseId) {
  // WMS сообщает об ошибке полем error — бывает и при HTTP 200
  // (USER_ALREADY_HAS_A_SHIFT приходит так), поэтому смотрим и статус, и тело
  const post = async (url, body) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { ...wmsHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    let data = null
    try { data = await r.json() } catch { /* пустой ответ — ок */ }
    const error = data?.error || (r.ok ? '' : String(r.status))
    return { ok: !error, error }
  }

  let res = await post(WMS_SHIFTS_URL, { warehouseId })
  if (res.error === 'USER_ALREADY_HAS_A_SHIFT') {
    const closed = await post(WMS_SHIFTS_URL + '/close', {})
    if (!closed.ok) throw new Error(`WMS не закрыл текущую смену: ${closed.error}`)
    res = await post(WMS_SHIFTS_URL, { warehouseId })
  }
  if (!res.ok) throw new Error(`WMS не сменил склад: ${res.error}`)
  // проверяем, что склад в WMS действительно сменился
  const now = await getWmsWarehouseId(token, { fresh: true }).catch(() => null)
  if (now && now !== warehouseId) throw new Error('WMS не сменил склад — смените его в шапке WMS')
  wmsWarehouseCache = { token, id: warehouseId, at: Date.now() }
  return true
}

export async function samokatPost(token, url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...wmsHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  const trimmed = (text || '').trim().toLowerCase()
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    throw new Error('Нет доступа к API. Проверьте VPN или войдите заново.')
  }
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error('Ответ не JSON: ' + (text || '').slice(0, 150))
  }
  if (!r.ok) throw new Error(`API ${r.status}: ${data?.message || data?.error || r.statusText}`)
  return data
}

// Порт fetchDataViaBrowser/fetchPlacementViaBrowser/fetchRemainsViaBrowser
// из оригинала (api/index.js). Каждая — своя пагинация по WMS, а сохранение
// результата — POST в свой же бэкенд (тот же /api/save-fetched-data и
// /api/stats/{placement,remains}/save, что уже вызывают same-origin пути в
// new zlp — эти функции просто дают им реальные данные вместо демо-фетча).

// Сохранение выгрузки у нас — со складом, выбранным сейчас в WMS (см. выше).
// Не удалось узнать склад в WMS — выбранный на сайте. `wrap: false` — тело
// уходит как есть, без обёртки { value }.
export async function postOwnBackend(url, value, token, { wrap = true } = {}) {
  const warehouseId = (await getWmsWarehouseId(token).catch(() => null)) || null
  const r = await fetch(url, {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json', ...(warehouseId ? { 'X-Warehouse': warehouseId } : {}) }),
    body: JSON.stringify(wrap ? { value } : value),
    credentials: 'include',
  })
  const text = await r.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error(`Сервер вернул не JSON (${r.status}): ${text.slice(0, 150)}`)
  }
  if (!r.ok) throw new Error(r.status === 403 ? 'В WMS выбран склад, к которому у вас нет доступа на сайте — данные не сохранены' : (data?.error || r.statusText || `HTTP ${r.status}`))
  return { ...data, warehouseId }
}

// Общая библиотека WMS-запросов, шарится между AnalysisPage/HourlyReport/
// SuppliesPage/EoSearchPage/SupplyDetailPage.

export async function samokatGet(token, url, params) {
  const r = await fetch(`${url}?${params}`, {
    headers: { ...wmsHeaders(token), 'X-Who': 'a3327d34-1f6b-46bb-9936-0306ec6c21ad' },
  })
  const text = await r.text()
  const trimmed = (text || '').trim().toLowerCase()
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    throw new Error('Нет доступа к API. Проверьте VPN или войдите заново.')
  }
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error('Ответ не JSON: ' + (text || '').slice(0, 150))
  }
  if (!r.ok) throw new Error(`API ${r.status}: ${data?.message || data?.error || r.statusText}`)
  return data
}
