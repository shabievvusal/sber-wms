import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { getStoredToken, fetchZoneCells } from '@/lib/wmsFetch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { confirmDialog } from '@/components/ui/confirm'
import { SettingCard } from './SettingCard'
import { IconAction } from './ui'
import { ChevronDown, ChevronRight, Plus, RefreshCw, Store, Trash2 } from 'lucide-react'

const fmtDateTime = iso => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')
// зона «КДК холод» СПБ-3 — подсказка для первого добавления
const DEFAULT_ZONE_ID = '5a56fc9f-ed86-464c-951b-12acbbb83a07'

// Только admin/developer (см. SettingsPage.jsx) — справочник «ячейка КДК →
// ЦФЗ» из WMS (topology/v2/cells/find, storeName), по зонам. Используется в
// «Поиске потеряшек»: куда должна уехать найденная ЕО.
export function CellStoresCard() {
  const [data, setData] = useState(null)
  const [busyZone, setBusyZone] = useState(null)
  const [newZoneId, setNewZoneId] = useState('')
  const [open, setOpen] = useState(false)

  const load = () => api.getCellStores().then(setData).catch(err => toast.error('Ошибка: ' + err.message))
  useEffect(() => { load() }, [])
  useEffect(() => { if (data && !data.zones.length && !newZoneId) setNewZoneId(DEFAULT_ZONE_ID) }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const syncZone = async zoneId => {
    const token = getStoredToken()
    if (!token) { toast.error('Нет активного WMS-токена — войдите паролем от WMS'); return false }
    setBusyZone(zoneId)
    try {
      const { zoneName, cells } = await fetchZoneCells(token, zoneId)
      if (!cells.length) { toast.error('В зоне нет ячеек — проверьте ID зоны'); return false }
      await api.syncCellStores(zoneId, zoneName, cells)
      toast.success(`${zoneName || 'Зона'}: ячеек ${cells.length}, ЦФЗ ${new Set(cells.map(c => c.storeName).filter(Boolean)).size}`)
      await load()
      return true
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
      return false
    } finally {
      setBusyZone(null)
    }
  }

  const syncAll = async () => {
    for (const z of data?.zones || []) if (!(await syncZone(z.zoneId))) break
  }

  const addZone = async () => {
    const id = newZoneId.trim()
    if (!id) return
    if (await syncZone(id)) setNewZoneId('')
  }

  const removeZone = async z => {
    if (!(await confirmDialog({ title: `Убрать зону «${z.zoneName || z.zoneId}»?`, description: `Из справочника удалятся ${z.cells} ячеек с ЦФЗ. Вернуть — добавить зону заново.`, confirmText: 'Убрать', danger: true }))) return
    try {
      await api.deleteCellStoreZone(z.zoneId)
      await load()
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    }
  }

  // ЦФЗ → его ячейки
  const byStore = useMemo(() => {
    const m = new Map()
    for (const c of data?.cells || []) {
      const s = c.storeName || '— без ЦФЗ —'
      if (!m.has(s)) m.set(s, [])
      m.get(s).push(c.address)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'))
  }, [data])

  return (
    <SettingCard icon={Store} title="ЦФЗ по ячейкам КДК" subtitle="Какой магазин закреплён за ячейкой — подтягивается из WMS">
      <div className="space-y-2">
        {(data?.zones || []).map(z => (
          <div key={z.zoneId} className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface-2/60 p-3">
            <div className="min-w-0 flex-1 basis-48">
              <div className="text-sm font-medium">{z.zoneName || z.zoneId}</div>
              <div className="text-xs text-muted-foreground">ячеек {z.cells} · ЦФЗ {z.stores} · обновлено {fmtDateTime(z.updatedAt)}</div>
              {z.noCellId > 0 && <div className="text-xs text-warning">нет id ячеек WMS у {z.noCellId} — нажмите «Обновить»</div>}
            </div>
            <Button size="sm" variant="outline" disabled={!!busyZone} onClick={() => syncZone(z.zoneId)}>
              <RefreshCw className={busyZone === z.zoneId ? 'size-3.5 animate-spin' : 'size-3.5'} /> Обновить
            </Button>
            <IconAction icon={Trash2} title="Убрать зону" tone="danger" disabled={!!busyZone} onClick={() => removeZone(z)} />
          </div>
        ))}
        {data && !data.zones.length && <div className="text-sm text-muted-foreground">Зон пока нет — добавьте зону КДК по её ID из WMS.</div>}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input className="h-8 max-w-sm font-mono text-xs" value={newZoneId} onChange={e => setNewZoneId(e.target.value)} placeholder="ID зоны из WMS (zoneId)" />
        <Button size="sm" variant="secondary" disabled={!!busyZone || !newZoneId.trim()} onClick={addZone}>
          <Plus className="size-3.5" /> {busyZone && busyZone === newZoneId.trim() ? 'Загрузка…' : 'Добавить зону'}
        </Button>
        {data?.zones?.length > 1 && (
          <Button size="sm" variant="outline" disabled={!!busyZone} onClick={syncAll}><RefreshCw className="size-3.5" /> Обновить все</Button>
        )}
      </div>

      {byStore.length > 0 && (
        <div className="mt-3">
          <button type="button" className="flex items-center gap-1 text-xs font-medium text-primary" onClick={() => setOpen(o => !o)}>
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} ЦФЗ и их ячейки ({byStore.length})
          </button>
          {open && (
            <div className="mt-2 max-h-80 space-y-1 overflow-y-auto rounded-2xl border p-3 text-xs">
              {byStore.map(([store, cells]) => (
                <div key={store} className="flex gap-2">
                  <span className="w-64 shrink-0 font-medium">{store}</span>
                  <span className="text-muted-foreground">{cells.join(', ')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        ID зоны — из запроса WMS к ячейкам зоны (поле zoneId). Если ячейки перезакрепили за другими магазинами — нажмите «Обновить».
      </p>
    </SettingCard>
  )
}
