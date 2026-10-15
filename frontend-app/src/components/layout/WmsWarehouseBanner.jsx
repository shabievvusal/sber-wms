import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/context/AuthContext'
import { getStoredToken, getWmsWarehouseId, switchWmsWarehouse } from '@/lib/wmsFetch'
import { useWarehouse, shortWarehouseName, switchWarehouse } from '@/lib/warehouse'
import { isEmbedded } from '@/lib/embed'

const CHECK_MS = 2 * 60_000

/**
 * Склад в WMS ≠ склад на сайте. У учётки в WMS выбран один склад (во всех её
 * сессиях), и всё, что сайт берёт из WMS напрямую (мониторинг, поставки,
 * комплектация, выгрузки статистики), — данные именно этого склада. Если на
 * сайте выбран другой, показываем это и предлагаем выровнять.
 *
 * Внутри WMS (расширение) сайт сам переходит на склад, открытый в WMS.
 */
export function WmsWarehouseBanner() {
  const { user } = useAuth()
  const { id: siteId, list } = useWarehouse(user)
  const [wmsId, setWmsId] = useState(null)
  const [busy, setBusy] = useState(false)

  const check = useCallback(async (fresh = false) => {
    const token = getStoredToken()
    if (!token) { setWmsId(null); return }
    try { setWmsId(await getWmsWarehouseId(token, { fresh })) } catch { /* WMS недоступен — промолчим */ }
  }, [])

  useEffect(() => {
    check()
    const t = setInterval(() => { if (document.visibilityState === 'visible') check(true) }, CHECK_MS)
    const onFocus = () => check(true)
    window.addEventListener('focus', onFocus)
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus) }
  }, [check])

  const accessible = !!wmsId && list.some(w => w.id === wmsId)
  const mismatch = !!wmsId && !!siteId && wmsId !== siteId

  // внутри WMS — сайт следует за складом WMS
  useEffect(() => {
    if (isEmbedded && mismatch && accessible) switchWarehouse(wmsId)
  }, [mismatch, accessible, wmsId])

  if (!mismatch || (isEmbedded && accessible)) return null

  const name = id => shortWarehouseName(list.find(w => w.id === id)?.name || '')
  const siteName = name(siteId)
  const wmsName = accessible ? name(wmsId) : 'другой склад'

  const alignWms = async () => {
    setBusy(true)
    try {
      await switchWmsWarehouse(getStoredToken(), siteId)
      toast.success(`В WMS выбран склад ${siteName}`)
      setWmsId(siteId)
    } catch (err) {
      toast.error(err.message || 'Не удалось сменить склад в WMS')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-warning/25 bg-warning/10 px-4 py-2.5 text-sm print:hidden">
      <AlertTriangle className="size-4 shrink-0 text-warning" />
      <span className="min-w-0 flex-1">
        В WMS у вас выбран <b>{wmsName}</b>, а на сайте — <b>{siteName}</b>. Разделы, которые берут данные прямо из WMS, покажут {accessible ? wmsName : 'данные другого склада'}, и выгрузки из WMS сохранятся {accessible ? `в ${wmsName}` : 'не будут (нет доступа)'}.
      </span>
      <span className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={alignWms} title="Сменит склад в WMS во всех ваших сессиях — как выбор склада в шапке WMS">
          Переключить WMS на {siteName}
        </Button>
        {accessible && (
          <Button size="sm" variant="ghost" onClick={() => switchWarehouse(wmsId)}>Перейти на сайте на {wmsName}</Button>
        )}
      </span>
    </div>
  )
}
