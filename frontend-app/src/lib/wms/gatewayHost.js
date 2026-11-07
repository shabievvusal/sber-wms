// Шлюз WMS работает сам: любая открытая вкладка robops.ru, где у человека есть
// своя живая сессия WMS (токен от расширения, продлевается сам), подхватывает
// запросы тех, у кого сессии нет, — для склада, выбранного в WMS у этой учётки.
// В браузере шлюзом работает одна вкладка (Web Locks), остальные ждут: закрыли
// её — эстафету берёт следующая. Сессия WMS кончилась — вкладка перестаёт
// брать запросы, их берёт другой шлюз склада.
import { useSyncExternalStore } from 'react'
import { getOwnToken, getWmsWarehouseId } from './core.js'
import { runGatewayHost } from './gateway.js'

const CHECK_MS = 30_000
const LOCK = 'robops-wms-gateway-host'

const store = {
  state: { running: false, wh: null, done: 0, failed: 0, active: 0, events: [], error: '' },
  listeners: new Set(),
  set(patch) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(fn => fn())
  },
}

export function useGatewayHost() {
  return useSyncExternalStore(fn => { store.listeners.add(fn); return () => store.listeners.delete(fn) }, () => store.state)
}

let stopLoop = null
let releaseLock = null
let hasLock = false
let started = false

function onEvent(ev) {
  const s = store.state
  if (ev.type === 'job') store.set({ active: s.active + 1, error: '' })
  else if (ev.type === 'done') {
    const ok = ev.status >= 200 && ev.status < 300
    store.set({
      active: Math.max(0, s.active - 1),
      done: s.done + (ok ? 1 : 0),
      failed: s.failed + (ok ? 0 : 1),
      events: [{ at: new Date(), login: ev.job.login, method: ev.job.method, path: new URL(ev.job.url).pathname, status: ev.status, ms: ev.ms }, ...s.events].slice(0, 30),
    })
  } else if (ev.type === 'error') store.set({ error: ev.message })
  else if (ev.type === 'idle' && s.error) store.set({ error: '' })
}

function stop() {
  stopLoop?.()
  stopLoop = null
  store.set({ running: false, wh: null, active: 0 })
}

// одна вкладка браузера на шлюз; без Web Locks (старый браузер) — каждая вкладка
function acquireLock() {
  if (hasLock) return Promise.resolve(true)
  if (!navigator.locks?.request) { hasLock = true; return Promise.resolve(true) }
  return new Promise(resolve => {
    navigator.locks.request(LOCK, { ifAvailable: true }, lock => {
      if (!lock) { resolve(false); return undefined }
      hasLock = true
      resolve(true)
      return new Promise(release => { releaseLock = release })
    })
  })
}

function dropLock() {
  releaseLock?.()
  releaseLock = null
  hasLock = false
}

async function tick() {
  const token = getOwnToken()
  if (!token) { if (store.state.running) stop(); dropLock(); return }
  if (!(await acquireLock())) return // шлюзом уже работает другая вкладка этого браузера
  let wh = null
  try { wh = await getWmsWarehouseId(token, { fresh: true }) } catch { /* WMS не ответил — попробуем позже */ }
  if (!wh) return
  if (store.state.running && store.state.wh === wh) return
  // склад в WMS сменили — обслуживаем новый
  if (store.state.running) stop()
  stopLoop = runGatewayHost({ getToken: getOwnToken, wmsWarehouseId: wh, onEvent, loops: 2 })
  store.set({ running: true, wh, error: '' })
}

/** Запустить фоновый шлюз этой вкладки (App.jsx, один раз после входа). */
export function startAutoGatewayHost() {
  if (started) return
  started = true
  tick()
  setInterval(tick, CHECK_MS)
  window.addEventListener('focus', tick)
}
