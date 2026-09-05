import { useCallback, useEffect, useRef } from 'react'
import * as api from '@/lib/api'
import { getStoredToken, fetchRouteFromWMS } from '@/lib/wmsFetch'

// ─── Фоновое обновление списков ЕО ─────────────────────────────────────────
// У обычного кладовщика нет WMS-токена: сходить за ЕО в WMS может только
// браузер с живой WMS-сессией. Раньше на странице «Приёмка → Список ЕО» у
// него была кнопка, которая ставила маршрут в очередь на бэкенде в расчёте,
// что его обработает другое устройство — но эту очередь в этом фронтенде не
// разбирал никто (в оригинале это делал AppContext.jsx, при переносе
// потерялось), поэтому список ЕО не обновлялся вообще.
//
// Теперь ручных запросов нет совсем (2026-09-06): устройство, на котором
// включено «Автообновление» (Настройки → Система, тот же флаг
// `vs_auto_fetch_enabled`, что и у автосбора статистики), само обновляет ЕО
// по всем актуальным маршрутам раз в 5 минут. Статистика при этом
// обновляется как раньше, своим расписанием (StatsPage.jsx) — этот
// планировщик её не трогает.
//
// Живёт в AppShell, а не на странице приёмки: обновлять должен корп.
// компьютер, а на нём открыта своя страница (обычно статистика), и вообще
// не факт, что кто-то держит открытым «Список ЕО».

export const EO_AUTO_REFRESH_MS = 5 * 60_000 // как часто корп. устройство ходит в WMS
export const EO_POLL_MS = 30_000             // как часто экран кладовщика перечитывает наш бэкенд
const TICK_MS = 60_000                       // проверка «не пора ли» — как у планировщика статистики
const TARGET_DAYS = 2                        // сегодня + вчера (ночная смена)
const LS_AUTO_FETCH_ENABLED = 'vs_auto_fetch_enabled'
const LS_LAST_RUN = 'vs_eo_auto_refresh_last'

function autoFetchEnabled() {
  try { return localStorage.getItem(LS_AUTO_FETCH_ENABLED) === '1' } catch { return false }
}

/** Время последнего полного прохода НА ЭТОМ устройстве (мс), 0 — не было. */
export function readEoLastRun() {
  try { return Number(localStorage.getItem(LS_LAST_RUN)) || 0 } catch { return 0 }
}

/**
 * Один полный проход: обновить ЕО по всем актуальным маршрутам и сохранить
 * у нас. Общий код планового прохода и ручной кнопки «Обновить сейчас»
 * (Настройки → Система → «Автообновление») — единственные два места, откуда
 * вообще ходят в WMS за ЕО. Возвращает `{ total, ok, failed }`.
 */
export async function refreshAllEoNow(token, onProgress) {
  const targets = (await api.getEoRefreshTargets(TARGET_DAYS)) || []
  const routes = targets.filter(t => t?.routeId)
  let ok = 0
  let failed = 0
  for (const [i, t] of routes.entries()) {
    onProgress?.(i, routes.length)
    try {
      const wmsData = await fetchRouteFromWMS(token, t.routeId)
      await api.saveRouteEosRefresh(t.routeId, wmsData)
      ok += 1
    } catch {
      failed += 1 // один маршрут не должен рушить остальные
    }
  }
  try { localStorage.setItem(LS_LAST_RUN, String(Date.now())) } catch { /* ignore */ }
  return { total: routes.length, ok, failed }
}

export function EoAutoRefresh() {
  const busyRef = useRef(false)
  const lastRunRef = useRef(readEoLastRun())

  // Плановое обновление всех актуальных маршрутов — раз в EO_AUTO_REFRESH_MS.
  const refreshAll = useCallback(async token => {
    try { await refreshAllEoNow(token) } catch { /* следующий тик попробует снова */ }
    lastRunRef.current = readEoLastRun() || Date.now()
  }, [])

  useEffect(() => {
    const tick = async () => {
      if (busyRef.current) return
      if (!autoFetchEnabled()) return
      if (Date.now() - lastRunRef.current < EO_AUTO_REFRESH_MS) return
      const token = getStoredToken()
      if (!token) return // без WMS-сессии это устройство ничем помочь не может
      busyRef.current = true
      try { await refreshAll(token) } finally { busyRef.current = false }
    }
    tick()
    const t = setInterval(tick, TICK_MS)
    return () => clearInterval(t)
  }, [refreshAll])

  return null
}
