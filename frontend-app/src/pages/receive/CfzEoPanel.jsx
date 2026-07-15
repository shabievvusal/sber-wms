import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { getStoredToken, fetchRouteFromWMS } from '@/lib/wmsFetch'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { RefreshCw, Loader2, ChevronUp, ChevronDown } from 'lucide-react'
import { fmtDate } from './format'

/**
 * Порт CfzEoPanel оригинала. Ключ — `store.address`, не числовой `store.storeId`
 * (тот же формат, что и у остальных CFZ-адресов в этом разделе).
 *
 * «Обновить из WMS» — если в браузере есть настоящий WMS-токен, реально
 * бьёт в api-p01.samokat.ru (fetchRouteFromWMS) и сохраняет результат —
 * как в оригинале. Без токена — как и оригинал, ставит запрос в очередь
 * (`api.requestEoRefresh`) в расчёте, что его обработает какое-то ДРУГОЕ
 * устройство с активным WMS-токеном; честно сообщает об этом тостом, а не
 * притворяется, что данные обновились.
 */
export function CfzEoPanel({ routeId, store, onCountsUpdate }) {
  const [storeData, setStoreData] = useState(null)
  const [removedEos, setRemovedEos] = useState([])
  const [requesting, setRequesting] = useState(false)
  const [error, setError] = useState('')

  const applyData = cfzData => {
    const eos = cfzData?.eos || []
    const removed = cfzData?.removedEos || []
    setStoreData(cfzData || { address: store.address, eos: [] })
    setRemovedEos(removed)
    onCountsUpdate?.(store.address, eos.length, removed.length)
  }

  const loadEos = () => {
    api.getRouteEos(routeId)
      .then(data => applyData(data[store.address]))
      .catch(err => { setError(err.message || 'Не удалось загрузить ЕО'); applyData(null) })
  }

  useEffect(() => {
    setStoreData(null)
    setRemovedEos([])
    setError('')
    loadEos()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId, store.address])

  const handleRefresh = async () => {
    setError('')
    setRequesting(true)
    const token = getStoredToken()
    try {
      if (token) {
        const wmsData = await fetchRouteFromWMS(token, routeId)
        await api.saveRouteEosRefresh(routeId, wmsData)
        loadEos()
      } else {
        await withMinDuration(async () => { await api.requestEoRefresh(routeId).catch(() => {}) })
        toast.info('Запрос поставлен в очередь — обновление из WMS требует активного устройства с открытой WMS-сессией')
        loadEos()
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setRequesting(false)
    }
  }

  if (storeData === null && !error) return <Spinner label="Загрузка..." />

  const eos = storeData?.eos || []

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      {error && <div className="text-sm text-destructive">{error}</div>}
      {storeData !== null && (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">
              {eos.length} ЕО{removedEos.length > 0 ? ` · ${removedEos.length} удалено` : ''}
            </span>
            <Button size="sm" variant="outline" onClick={handleRefresh} disabled={requesting}>
              {requesting ? <><Loader2 className="size-3.5 animate-spin" /> Ожидание...</> : <><RefreshCw className="size-3.5" /> Обновить из WMS</>}
            </Button>
          </div>
          {eos.length === 0 && removedEos.length === 0 && <div className="text-sm text-muted-foreground">ЕО не найдены</div>}
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {eos.map((eo, i) => (
              <div key={i} className="flex items-center justify-between rounded bg-card px-2 py-1 text-xs">
                <span className="font-mono">{eo.barcode}</span>
                {eo.weight != null && <span className="text-muted-foreground">{Number(eo.weight).toFixed(2)} кг</span>}
              </div>
            ))}
            {removedEos.map((eo, i) => (
              <div key={`rm-${i}`} className="flex items-center justify-between rounded bg-card px-2 py-1 text-xs opacity-60">
                <span className="font-mono line-through">{eo.barcode}</span>
                {eo.weight != null && <span className="text-muted-foreground">{Number(eo.weight).toFixed(2)} кг</span>}
                <span className="text-destructive">удалено</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export function StepEoList({ route }) {
  const [openAddress, setOpenAddress] = useState(null)
  const cfz = route.cfzAddresses || []

  const [eoCounts, setEoCounts] = useState(() => Object.fromEntries(cfz.map(a => [a.address, { eos: 0, removed: 0 }])))

  useEffect(() => {
    api.getRouteEos(route.routeId)
      .then(data => {
        setEoCounts(prev => {
          const next = { ...prev }
          for (const [address, d] of Object.entries(data)) next[address] = { eos: d.eos?.length || 0, removed: d.removedEos?.length || 0 }
          return next
        })
      })
      .catch(() => {
        setEoCounts(Object.fromEntries(cfz.map(a => [a.address, { eos: 0, removed: 0 }])))
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.routeId])

  const handleCountsUpdate = (address, eosCount, removedCount) => setEoCounts(prev => ({ ...prev, [address]: { eos: eosCount, removed: removedCount } }))

  const totalEos = Object.values(eoCounts).reduce((s, c) => s + c.eos, 0)
  const totalRemoved = Object.values(eoCounts).reduce((s, c) => s + c.removed, 0)

  const toggle = address => setOpenAddress(prev => prev === address ? null : address)

  return (
    <div className="space-y-4">
      <div className="space-y-1 rounded-lg border bg-card p-3">
        <div className="font-semibold">{route.routeNumber || '—'}</div>
        <div className="text-sm text-muted-foreground">
          {fmtDate(route.date)}
          {route.driver ? ` · ${route.driver.name}` : ''}
          {route.vehicle ? ` · ${route.vehicle.number}` : ''}
        </div>
        {(totalEos > 0 || totalRemoved > 0) && (
          <div className="text-sm">{totalEos} ЕО{totalRemoved > 0 ? ` · ${totalRemoved} удалено` : ''}</div>
        )}
      </div>

      <div className="text-sm font-medium">Нажмите на ЦФЗ для просмотра ЕО</div>

      {cfz.length === 0 && <div className="text-sm text-muted-foreground">Нет адресов ЦФЗ</div>}

      <div className="space-y-2">
        {cfz.map(a => {
          const isOpen = openAddress === a.address
          const counts = eoCounts[a.address] || { eos: 0, removed: 0 }
          return (
            <div key={a.address}>
              <button
                className={`flex w-full items-center gap-2 rounded-md border bg-card p-2.5 text-left ${isOpen ? 'border-primary' : ''}`}
                onClick={() => toggle(a.address)}
              >
                <span className="flex-1 text-sm">{a.address}</span>
                {(counts.eos > 0 || counts.removed > 0) && (
                  <span className="text-xs text-muted-foreground">{counts.eos} ЕО{counts.removed > 0 ? ` · ${counts.removed} удал.` : ''}</span>
                )}
                {isOpen ? <ChevronUp className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />}
              </button>
              {isOpen && (
                <div className="mt-1.5">
                  <CfzEoPanel routeId={route.routeId} store={a} onCountsUpdate={handleCountsUpdate} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
