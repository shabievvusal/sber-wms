// Шлюз WMS работает сам: любая открытая вкладка robops.ru, где у человека есть
// своя живая сессия WMS (токен от расширения, продлевается сам), подхватывает
// запросы тех, у кого сессии нет, — для склада, выбранного в WMS у этой учётки.
// В браузере шлюзом работает одна вкладка (Web Locks), остальные ждут: закрыли
// её — эстафету берёт следующая. Сессия WMS кончилась — вкладка перестаёт
// брать запросы, их берёт другой шлюз склада.
import { useSyncExternalStore } from 'react'
import { getOwnToken } from './core.js'
import { runGatewayHost, directFetch, markWmsDirectOk, markWmsDirectBroken } from './gateway.js'
import { fetchDataViaBrowser, fetchPlacementViaBrowser, fetchRemainsViaBrowser, fetchStockMovesViaBrowser, fetchReceivingViaBrowser } from './collect.js'

// задания целиком, которые шлюз выполняет сам (WmsGatewayService.TasksAllowed)
const TASKS = {
  'collect:ops': fetchDataViaBrowser,
  'collect:placement': fetchPlacementViaBrowser,
  'collect:remains': fetchRemainsViaBrowser,
  'collect:moves': fetchStockMovesViaBrowser,
  'collect:receiving': fetchReceivingViaBrowser,
}
function runTask(name, token, args) {
  const fn = TASKS[name]
  if (!fn) throw new Error('Неизвестное задание ' + name)
  return fn(token, args)
}

const WMS_FEATURES_URL = 'https://api.samokat.ru/wmsops-wwh/warehouses/features-configuration'
// второй сервер WMS (штучный отбор, отгрузки, КДК) — бывает недоступен там,
// где api.samokat.ru открывается (телефон без VPN)
const WMS_P01_PROBE_URL = 'https://api-p01.samokat.ru/wmsout-pdt/pbl/zones'

// Склад в WMS — запросом напрямую, без шлюза: заодно проверка, что с этого
// компьютера WMS вообще доступна. Нет — эта вкладка шлюзом не работает.
async function probeWms(token) {
  try {
    const r = await directFetch(WMS_FEATURES_URL, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } })
    if (!r.ok) return null
    const d = await r.json()
    // до второго сервера — достаточно любого ответа (сеть есть)
    await directFetch(WMS_P01_PROBE_URL, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } })
    markWmsDirectOk()
    return d?.value?.warehouseId || null
  } catch {
    // сеть до WMS недоступна — запросы этого компьютера пойдут через шлюз
    markWmsDirectBroken()
    return null
  }
}

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
  const wh = await probeWms(token)
  // WMS с этого компьютера недоступна — шлюзом не работаем, запросы возьмут другие
  if (!wh) { if (store.state.running) stop(); store.set({ error: 'WMS с этого компьютера недоступна (нет сети до WMS или сессия не действует)' }); return }
  if (store.state.running && store.state.wh === wh) return
  // склад в WMS сменили — обслуживаем новый
  if (store.state.running) stop()
  stopLoop = runGatewayHost({
    getToken: getOwnToken, wmsWarehouseId: wh, onEvent, runTask, loops: 4,
    // сеть до WMS пропала — запросы этого компьютера тоже через шлюз, шлюзом не работаем
    onNetworkFail: () => { markWmsDirectBroken(); stop(); store.set({ error: 'WMS с этого компьютера недоступна — шлюзом не работаю' }) },
  })
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
