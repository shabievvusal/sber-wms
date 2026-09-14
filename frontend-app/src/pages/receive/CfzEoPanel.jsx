import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '@/lib/api'
import { getStoredToken, fetchRouteFromWMS } from '@/lib/wmsFetch'
import { EO_AUTO_REFRESH_MS, EO_POLL_MS } from '@/lib/eoAutoRefresh'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { RefreshCw, Loader2, ChevronUp, ChevronDown } from 'lucide-react'
import { fmtDate, fmtUpdatedAt } from './format'
import { EO_STAGES, eoStage, sortByStage, summarizeEos, routeShipStatus, cfzShipStatus } from './eoStatus'

/**
 * Порт CfzEoPanel оригинала. Ключ — `store.storeId` (uuid ЦФЗ), как и отдаёт
 * бэкенд (`getRouteEos` → `{ [storeId]: { address, eos, removedEos } }`), и
 * как было в оригинале. При переносе ключом был взят `store.address` —
 * из-за чего данные не находились НИКОГДА: счётчик у адреса всегда показывал
 * 0, а раскрытая панель — «ЕО не найдены», сколько ни обновляй.
 *
 * Сами ЕО грузит и перечитывает родитель (StepEoList) — один запрос на весь
 * маршрут вместо одного на каждый раскрытый адрес.
 *
 * Кнопки обновления здесь больше нет: она обновляла ВЕСЬ маршрут (WMS отдаёт
 * его целиком), поэтому одинаковая кнопка в каждой раскрытой панели только
 * путала — переехала один раз в шапку маршрута (StepEoList ниже). Обычному
 * кладовщику она в любом случае не показывается: сходить в WMS может только
 * браузер с WMS-токеном, а списки обновляет фоном устройство с включённым
 * автообновлением, раз в 5 минут (см. lib/eoAutoRefresh.jsx) — сюда
 * обновление приезжает само, следующим опросом.
 *
 * Статусы «подвезено к воротам» / «загружено в машину» — см. ./eoStatus.js.
 */
export function CfzEoPanel({ storeData }) {
  const eos = storeData?.eos || []
  const removedEos = storeData?.removedEos || []
  const updatedAt = fmtUpdatedAt(storeData?.eosUpdatedAt)
  const summary = summarizeEos(eos)

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="text-sm font-medium">
        {eos.length} ЕО{removedEos.length > 0 ? ` · ${removedEos.length} удалено` : ''}
      </div>
      {summary.total > 0 && summary.unknown < summary.total && (
        <div className="text-xs">
          Подвезено {summary.atGate} из {summary.total} · Загружено {summary.loaded} из {summary.total}
        </div>
      )}
      <div className="text-xs text-muted-foreground">
        {updatedAt ? `Обновлено ${updatedAt}` : 'Ещё ни разу не обновлялось из WMS'}
      </div>
      {eos.length === 0 && removedEos.length === 0 && <div className="text-sm text-muted-foreground">ЕО не найдены</div>}
      <div className="max-h-64 space-y-1 overflow-y-auto">
        {sortByStage(eos).map((eo, i) => {
          const stage = EO_STAGES[eoStage(eo)]
          return (
            <div key={eo.barcode || i} className="flex items-center gap-2 rounded bg-card px-2 py-1 text-xs">
              <span className="font-mono">{eo.barcode}</span>
              {eo.weight != null && <span className="text-muted-foreground">{Number(eo.weight).toFixed(2)} кг</span>}
              <Badge variant={stage.variant} className="ml-auto">{stage.label}</Badge>
            </div>
          )
        })}
        {removedEos.map((eo, i) => (
          <div key={`rm-${i}`} className="flex items-center gap-2 rounded bg-card px-2 py-1 text-xs opacity-60">
            <span className="font-mono line-through">{eo.barcode}</span>
            {eo.weight != null && <span className="text-muted-foreground">{Number(eo.weight).toFixed(2)} кг</span>}
            <span className="ml-auto text-destructive">удалено</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ProgressLine({ label, done, total }) {
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-xs">
        <span>{label}</span>
        <span className="text-muted-foreground">{done} из {total}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-muted">
        <div className={`h-full rounded ${done === total ? 'bg-success' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

// Смонтирован с key={routeId} (см. ReceivePage) — при смене маршрута
// компонент пересоздаётся, поэтому состояние ниже можно засеять один раз.
export function StepEoList({ route }) {
  const [openStoreId, setOpenStoreId] = useState(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const routeId = route.routeId
  const cfz = route.cfzAddresses || []
  // Только на устройстве с живой WMS-сессией. Кладовщику кнопка не нужна и не
  // показывается — его список обновляет фон. Ручное обновление СРАЗУ ПО ВСЕМ
  // маршрутам — в Настройках → Система → «Автообновление».
  const canRefreshFromWms = Boolean(getStoredToken())

  // Засеваем тем, что уже приехало вместе с маршрутом (и поиск, и
  // /api/rk/routes/:id отдают cfzAddresses уже с ЕО) — счётчики у адресов
  // видны сразу, без пустой «0 ЕО» до первого опроса.
  const [eoByStore, setEoByStore] = useState(() => Object.fromEntries(
    (route.cfzAddresses || [])
      .filter(a => a.storeId)
      .map(a => [a.storeId, { address: a.address, eos: a.eos || [], removedEos: a.removedEos || [], eosUpdatedAt: a.eosUpdatedAt || null }])
  ))

  // Экран кладовщика сам перечитывает наш бэкенд (не WMS — туда ему нельзя):
  // пока он открыт, обновление, сделанное фоном корп. устройством, доезжает
  // до него само, без нажатия кнопки и без перезагрузки страницы.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const load = useCallback(async () => {
    try {
      const data = await api.getRouteEos(routeId)
      if (!mountedRef.current) return
      setEoByStore(data || {})
      setError('')
    } catch (err) {
      if (!mountedRef.current) return
      setError(err.message || 'Не удалось загрузить ЕО')
    }
  }, [routeId])

  useEffect(() => {
    load()
    const t = setInterval(load, EO_POLL_MS)
    return () => clearInterval(t)
  }, [load])

  const stores = Object.values(eoByStore)
  const totalEos = stores.reduce((s, d) => s + (d.eos?.length || 0), 0)
  const totalRemoved = stores.reduce((s, d) => s + (d.removedEos?.length || 0), 0)
  const lastUpdated = stores.map(d => d.eosUpdatedAt).filter(Boolean).sort().pop()
  const routeSummary = summarizeEos(stores.flatMap(d => d.eos || []))
  const routeStatus = routeShipStatus(routeSummary)

  const handleRefresh = async () => {
    setRefreshing(true)
    setError('')
    try {
      const wmsData = await fetchRouteFromWMS(getStoredToken(), routeId)
      await api.saveRouteEosRefresh(routeId, wmsData)
      await load()
    } catch (err) {
      setError(err.message || 'Не удалось обновить из WMS')
    } finally {
      setRefreshing(false)
    }
  }

  const toggle = storeId => setOpenStoreId(prev => prev === storeId ? null : storeId)

  return (
    <div className="space-y-4">
      <div className="space-y-1 rounded-lg border bg-card p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="font-semibold">{route.routeNumber || '—'}</div>
          {canRefreshFromWms && (
            <Button size="sm" variant="outline" onClick={handleRefresh} disabled={refreshing}>
              {refreshing ? <><Loader2 className="size-3.5 animate-spin" /> Обновление...</> : <><RefreshCw className="size-3.5" /> Обновить из WMS</>}
            </Button>
          )}
        </div>
        <div className="text-sm text-muted-foreground">
          {fmtDate(route.date)}
          {route.driver ? ` · ${route.driver.name}` : ''}
          {route.vehicle ? ` · ${route.vehicle.number}` : ''}
        </div>
        {(totalEos > 0 || totalRemoved > 0) && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {routeStatus && <Badge variant={routeStatus.variant}>{routeStatus.label}</Badge>}
            <span>{totalEos} ЕО{totalRemoved > 0 ? ` · ${totalRemoved} удалено` : ''}</span>
          </div>
        )}
        {routeSummary.total > 0 && routeSummary.unknown < routeSummary.total && (
          <div className="space-y-1.5 py-1">
            <ProgressLine label="Подвезено к воротам" done={routeSummary.atGate} total={routeSummary.total} />
            <ProgressLine label="Загружено в машину" done={routeSummary.loaded} total={routeSummary.total} />
          </div>
        )}
        <div className="text-xs text-muted-foreground">
          {lastUpdated ? `Обновлено ${fmtUpdatedAt(lastUpdated)}` : 'Ещё ни разу не обновлялось из WMS'}
          {` · автообновление каждые ${Math.round(EO_AUTO_REFRESH_MS / 60_000)} мин`}
        </div>
      </div>

      <div className="text-sm font-medium">Нажмите на ЦФЗ для просмотра ЕО</div>

      {error && <div className="text-sm text-destructive">{error}</div>}
      {cfz.length === 0 && <div className="text-sm text-muted-foreground">Нет адресов ЦФЗ</div>}

      <div className="space-y-2">
        {cfz.map(a => {
          const isOpen = openStoreId === a.storeId
          const d = eoByStore[a.storeId]
          const eoCount = d?.eos?.length || 0
          const removedCount = d?.removedEos?.length || 0
          const status = cfzShipStatus(summarizeEos(d?.eos))
          return (
            <div key={a.storeId || a.address}>
              <button
                className={`flex w-full flex-wrap items-center gap-2 rounded-md border bg-card p-2.5 text-left ${isOpen ? 'border-primary' : ''}`}
                onClick={() => toggle(a.storeId)}
              >
                <span className="min-w-0 flex-1 text-sm">{a.address}</span>
                {status && status.key !== 'unknown' && <Badge variant={status.variant}>{status.label}</Badge>}
                <span className="text-xs text-muted-foreground">
                  {eoCount} ЕО{removedCount > 0 ? ` · ${removedCount} удал.` : ''}
                </span>
                {isOpen ? <ChevronUp className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />}
              </button>
              {isOpen && (
                <div className="mt-1.5">
                  <CfzEoPanel storeData={d} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
