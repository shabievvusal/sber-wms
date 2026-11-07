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
import { toast } from 'sonner'
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

// fetch браузера как есть, без перехвата: прямой запрос в WMS
export const directFetch = typeof window !== 'undefined' ? window.fetch.bind(window) : null

// Свой токен есть, но до WMS с этого компьютера не достучаться (нет VPN или
// корпоративной сети — «Failed to fetch»): 5 минут запросы сразу идут через
// шлюз, без попытки напрямую; такая вкладка и шлюзом не работает.
const DIRECT_RETRY_MS = 5 * 60_000
let directBrokenAt = 0
export const wmsDirectBroken = () => Date.now() - directBrokenAt < DIRECT_RETRY_MS
export const markWmsDirectOk = () => { directBrokenAt = 0 }
export const markWmsDirectBroken = () => { directBrokenAt = Date.now() }

/**
 * Задание целиком на шлюзе (выгрузка статистики): шлюз сам качает из WMS и сам
 * сохраняет на сервер, сюда приходит только итог. Через шлюз по одной странице
 * та же выгрузка шла бы втрое дольше: каждая страница — шлюз → сервер → сюда →
 * снова на сервер. Функции в args (onProgress) не передаются.
 */
const TASK_LABELS = {
  'collect:ops': 'комплектация', 'collect:remains': 'остатки', 'collect:moves': 'спуск, пополнение, размещение',
  'collect:placement': 'размещение', 'collect:receiving': 'приёмка',
}

export async function runGatewayTask(name, args = {}) {
  const label = TASK_LABELS[name] || name
  const toastId = toast.loading(`Шлюз WMS · ${label}: отправляю задание…`)
  try {
    return await runGatewayTaskInner(name, args, text => toast.loading(`Шлюз WMS · ${label}: ${text}`, { id: toastId }))
  } finally {
    toast.dismiss(toastId)
  }
}

async function runGatewayTaskInner(name, args, show) {
  const r = await directFetch('/api/wms-gateway/request', {
    method: 'POST',
    credentials: 'include',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ method: 'TASK', url: name, body: JSON.stringify(args) }),
  })
  const d = await r.json().catch(() => null)
  if (!r.ok) {
    if (r.status === 503 || r.status === 504) refreshGatewayStatus()
    throw new Error(d?.error || `Шлюз WMS: HTTP ${r.status}`)
  }
  // задание идёт в фоне — спрашиваем раз в 2 с, готово ли (долгий открытый
  // запрос браузер телефона обрывает примерно через минуту тишины); сбой сети
  // между опросами (экран погас, сменилась сеть) не страшен — спросим снова
  const deadline = Date.now() + 20 * 60_000
  while (Date.now() < deadline) {
    await new Promise(res => setTimeout(res, 2000))
    let t
    try {
      const tr = await directFetch(`/api/wms-gateway/task/${encodeURIComponent(d.taskId)}`, { credentials: 'include', headers: apiHeaders() })
      t = await tr.json().catch(() => null)
      if (tr.status === 404) throw new Error(t?.error || 'Задание шлюза потерялось (сервер перезапускался?)')
      if (!tr.ok) continue
    } catch (err) {
      if (err instanceof TypeError) continue
      throw err
    }
    if (t?.status === 'queued') {
      show(t.hostsOnline
        ? `в очереди ${t.waitedSec} с — шлюз занят другими запросами`
        : `ждёт шлюз ${t.waitedSec} с — ни одного шлюза в сети`)
      continue
    }
    if (t?.status === 'running') { show(`выгружает шлюз ${t.host || ''} · ${t.runningSec} с`); continue }
    if (t?.status !== 'done') continue
    let result = null
    try { result = t.body ? JSON.parse(t.body) : null } catch { /* не JSON */ }
    if (t.code < 200 || t.code >= 300) throw new Error(result?.error || `Шлюз WMS: HTTP ${t.code}`)
    return result
  }
  throw new Error('Шлюз WMS не выполнил задание за 20 минут')
}

// Прямой запрос в WMS, который не дождался даже заголовков ответа за ms, —
// обрывается как сетевая ошибка. С телефона (мобильный user-agent) защита WMS
// не отвечает вовсе: запрос висел бесконечно — ни ошибки, ни прогресса; в
// режиме «версия для ПК» то же самое работало.
export async function fetchWithTimeout(input, init = {}, ms = 20_000) {
  const ctrl = new AbortController()
  const outer = init.signal
  if (outer) outer.addEventListener('abort', () => ctrl.abort(), { once: true })
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await directFetch(input, { ...init, signal: ctrl.signal })
  } catch (err) {
    // наш таймаут — как сетевая ошибка (TypeError), отмена извне — как есть
    if (ctrl.signal.aborted && !outer?.aborted) throw new TypeError('WMS не отвечает с этого устройства')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

let installed = false
export function installGatewayFetch() {
  if (installed || typeof window === 'undefined') return
  installed = true
  const nativeFetch = directFetch
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url
    let host = ''
    try { host = new URL(url, window.location.href).host } catch { /* не адрес */ }
    if (!WMS_HOSTS.has(host)) return nativeFetch(input, init)
    if (authOf(init.headers) !== `Bearer ${GATEWAY_TOKEN}`) {
      // свой токен: напрямую; сеть до WMS недоступна и шлюз есть — через шлюз
      const canGateway = state.access === 'approved' && state.online
      if (!(canGateway && wmsDirectBroken())) {
        try {
          return await fetchWithTimeout(input, init)
        } catch (err) {
          if (err instanceof TypeError) directBrokenAt = Date.now()
          if (!(err instanceof TypeError) || !(state.access === 'approved' && state.online)) throw err
        }
      }
    }
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
export function runGatewayHost({ getToken, wmsWarehouseId, onEvent, runTask, onNetworkFail, loops = 1 }) {
  let stopped = false
  const nativeFetch = window.fetch.bind(window)
  const own = (url, init = {}) => nativeFetch(url, { credentials: 'include', ...init, headers: apiHeaders({ 'Content-Type': 'application/json', ...(init.headers || {}) }) })

  const execute = async job => {
    const token = getToken()
    if (!token || isGatewayToken(token)) return { status: 503, body: JSON.stringify({ error: 'На шлюзе нет активной сессии WMS' }) }
    if (job.method === 'TASK') {
      try {
        const result = await runTask(job.url, token, job.body ? JSON.parse(job.body) : {})
        return { status: 200, body: JSON.stringify(result ?? {}) }
      } catch (err) {
        return { status: 500, body: JSON.stringify({ error: 'Шлюз: ' + (err.message || err) }) }
      }
    }
    try {
      const r = await fetchWithTimeout(job.url, {
        method: job.method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...WMS_EXTRA_HEADERS,
          ...(job.body != null ? { 'Content-Type': 'application/json' } : {}),
        },
        body: job.method === 'GET' ? undefined : job.body,
      }, 30_000)
      return { status: r.status, body: await r.text() }
    } catch (err) {
      // до WMS отсюда не достать (нет сети/VPN) — status 0: сервер вернёт
      // запрос в очередь другому шлюзу, а этот шлюз остановится
      onNetworkFail?.(err)
      return { status: 0, body: '' }
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
        if (res.status === 0) { stopped = true; return }
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
