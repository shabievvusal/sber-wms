// Шлюз WMS. У сотрудника нет своего токена WMS, но разработчик одобрил ему
// доступ к шлюзу, и шлюз склада в сети → getStoredToken() отдаёт вместо
// токена метку GATEWAY_TOKEN. Все запросы в WMS по-прежнему идут обычным
// fetch с заголовком Authorization — перехватчик ниже (installGatewayFetch)
// видит метку и отправляет запрос не в WMS, а на свой сервер
// (/api/wms-gateway/request). Сервер ставит его в очередь склада, шлюз —
// любая открытая вкладка сайта со своей сессией WMS (gatewayHost.js,
// runGatewayHost) — выполняет его в WMS своим токеном и возвращает ответ. Поэтому ни один раздел сайта переписывать не нужно.
//
// Только чтение: что пропускать, решает сервер (WmsGatewayService.Validate).
import { apiHeaders } from '@/lib/api'
import { useEffect, useState } from 'react'

export const GATEWAY_TOKEN = 'wms-gateway'
export const isGatewayToken = token => token === GATEWAY_TOKEN

const WMS_HOSTS = new Set(['api.samokat.ru', 'api-p01.samokat.ru'])
const STATUS_MS = 60_000

// ─── состояние шлюза для текущего пользователя ─────────────────────────────

let state = { access: 'none', online: false, lastSeen: null, isDeveloper: false, loaded: false }
const listeners = new Set()
const emit = () => listeners.forEach(fn => fn(state))

export const gatewayState = () => state
/** Шлюз можно использовать прямо сейчас: доступ одобрен и шлюз склада в сети. */
export const gatewayAvailable = () => state.access === 'approved' && state.online

export async function refreshGatewayStatus() {
  try {
    const r = await fetch('/api/wms-gateway/status', { credentials: 'include', headers: apiHeaders() })
    if (!r.ok) return state
    const d = await r.json()
    state = { access: d.access || 'none', online: !!d.online, lastSeen: d.lastSeen || null, isDeveloper: !!d.isDeveloper, loaded: true }
    emit()
  } catch { /* сеть — оставим прежнее */ }
  return state
}

let timer = null
/** Следить за состоянием шлюза (раз в минуту и при возврате на вкладку). */
export function startGatewayStatus() {
  if (timer) return
  refreshGatewayStatus()
  timer = setInterval(() => { if (document.visibilityState === 'visible') refreshGatewayStatus() }, STATUS_MS)
  window.addEventListener('focus', () => refreshGatewayStatus())
}

export function useWmsGateway() {
  const [s, setS] = useState(state)
  useEffect(() => {
    listeners.add(setS)
    setS(state)
    return () => listeners.delete(setS)
  }, [])
  return s
}

// ─── перехват запросов в WMS ────────────────────────────────────────────────

function authOf(headers) {
  if (!headers) return ''
  if (headers instanceof Headers) return headers.get('Authorization') || ''
  if (Array.isArray(headers)) return (headers.find(([k]) => k.toLowerCase() === 'authorization') || [])[1] || ''
  const key = Object.keys(headers).find(k => k.toLowerCase() === 'authorization')
  return key ? headers[key] : ''
}

let installed = false
export function installGatewayFetch() {
  if (installed || typeof window === 'undefined') return
  installed = true
  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url
    let host = ''
    try { host = new URL(url, window.location.href).host } catch { /* не адрес */ }
    if (!WMS_HOSTS.has(host) || authOf(init.headers) !== `Bearer ${GATEWAY_TOKEN}`) return nativeFetch(input, init)
    const method = (init.method || 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? init.body : null
    const r = await nativeFetch('/api/wms-gateway/request', {
      method: 'POST',
      credentials: 'include',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ method, url, body }),
    })
    // ошибка самого шлюза (нет доступа, не в сети, не дождались) — понятный текст
    if (!r.ok && r.headers.get('X-Wms-Gateway') !== '1') {
      const d = await r.clone().json().catch(() => null)
      if (r.status === 503 || r.status === 504) refreshGatewayStatus()
      return new Response(JSON.stringify({ error: d?.error || `Шлюз WMS: HTTP ${r.status}`, message: d?.error }), {
        status: r.status, headers: { 'Content-Type': 'application/json' },
      })
    }
    return r
  }
}

// ─── шлюз (любая вкладка сайта со своей сессией WMS, см. gatewayHost.js) ──────

const WMS_EXTRA_HEADERS = { 'X-Who': 'a3327d34-1f6b-46bb-9936-0306ec6c21ad' }

/**
 * Работать шлюзом, пока не остановят: забирать запросы склада wmsWarehouseId
 * с сервера, выполнять их в WMS токеном getToken() и возвращать ответ.
 * onEvent({ type: 'job'|'done'|'idle'|'error', ... }) — для экрана шлюза.
 */
export function runGatewayHost({ getToken, wmsWarehouseId, onEvent, loops = 1 }) {
  let stopped = false
  const nativeFetch = window.fetch.bind(window)
  const own = (url, init = {}) => nativeFetch(url, { credentials: 'include', ...init, headers: apiHeaders({ 'Content-Type': 'application/json', ...(init.headers || {}) }) })

  const execute = async job => {
    const token = getToken()
    if (!token || isGatewayToken(token)) return { status: 503, body: JSON.stringify({ error: 'На шлюзе нет активной сессии WMS' }) }
    try {
      const r = await nativeFetch(job.url, {
        method: job.method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...WMS_EXTRA_HEADERS,
          ...(job.body != null ? { 'Content-Type': 'application/json' } : {}),
        },
        body: job.method === 'GET' ? undefined : job.body,
      })
      return { status: r.status, body: await r.text() }
    } catch (err) {
      return { status: 502, body: JSON.stringify({ error: 'Шлюз не достучался до WMS: ' + (err.message || err) }) }
    }
  }

  const loop = async () => {
    while (!stopped) {
      // своя сессия WMS кончилась — не берём запросы, их возьмёт другой шлюз
      if (!getToken()) { await new Promise(res => setTimeout(res, 5000)); continue }
      try {
        const r = await own(`/api/wms-gateway/next?wh=${encodeURIComponent(wmsWarehouseId)}`)
        const d = await r.json().catch(() => null)
        if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`)
        if (!d?.job) { onEvent?.({ type: 'idle' }); continue }
        const job = d.job
        onEvent?.({ type: 'job', job, queue: d.queue })
        const started = Date.now()
        const res = await execute(job)
        await own('/api/wms-gateway/result', { method: 'POST', body: JSON.stringify({ id: job.id, wh: wmsWarehouseId, status: res.status, body: res.body }) })
        onEvent?.({ type: 'done', job, status: res.status, ms: Date.now() - started })
      } catch (err) {
        onEvent?.({ type: 'error', message: err.message || String(err) })
        await new Promise(res => setTimeout(res, 5000))
      }
    }
  }
  // несколько опросов параллельно — тяжёлая выгрузка одного не держит остальных
  for (let i = 0; i < loops; i++) loop()
  return () => { stopped = true }
}
