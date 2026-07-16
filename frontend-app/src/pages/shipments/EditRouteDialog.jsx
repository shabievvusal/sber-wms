import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Truck, PackageOpen, Loader2, Camera, X } from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Упрощённая версия оригинального 4-шагового FormModal (~550 строк, DOM-запросы
// через document.getElementById/querySelectorAll для динамических полей по ЦФЗ).
// Здесь — только редактирование УЖЕ существующего маршрута (то, для чего в
// таблице нужна кнопка «Изменить»), на обычном React state вместо чтения DOM.
// Мастер «создать новую отгрузку/приёмку с нуля» (шаги 1-3 оригинала) —
// отдельная задача, сознательно не перенесена в этот проход. Фото (добавление/
// удаление для уже существующего маршрута) перенесены — см. PhotoBlock ниже,
// портировано 1:1 с оригинала (FormStep4Edit/PhotoBlock в ShipmentsPage.jsx):
// existingPhotos (уже загруженные URL, "удаление" — просто исключение из
// массива, который потом целиком уходит в payload updateRkShipment/Receiving)
// + newPhotos (File[] ещё не загруженных, заливаются через uploadRkPhotos
// непосредственно перед сохранением).
// ─────────────────────────────────────────────────────────────────────────────

function PhotoBlock({ state, setState }) {
  const removeExisting = idx => setState(prev => ({ ...prev, existingPhotos: prev.existingPhotos.filter((_, i) => i !== idx) }))
  const removeNew = idx => setState(prev => ({ ...prev, newPhotos: prev.newPhotos.filter((_, i) => i !== idx) }))
  const addNew = files => setState(prev => ({ ...prev, newPhotos: [...prev.newPhotos, ...Array.from(files)] }))

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {state.existingPhotos.map((u, i) => (
          <div key={`e-${i}`} className="relative">
            <a href={u} target="_blank" rel="noreferrer">
              <img src={u} alt="фото" className="size-16 rounded object-cover" />
            </a>
            <button
              type="button"
              onClick={() => removeExisting(i)}
              className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        {state.newPhotos.map((f, i) => (
          <div key={`n-${i}`} className="relative">
            <img src={URL.createObjectURL(f)} alt="" className="size-16 rounded object-cover" />
            <button
              type="button"
              onClick={() => removeNew(i)}
              className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
      </div>
      <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <input type="file" accept="image/*" multiple className="hidden" onChange={e => addNew(e.target.files)} />
        <Camera className="size-3.5" /> Добавить фото
      </label>
    </div>
  )
}

function itemsToMap(items) {
  const map = {}
  for (const it of items || []) map[it.address] = it
  return map
}

function CfzSection({ icon: Icon, title, confirmed, by, setBy, gate, setGate, extra, cfzList, itemsState, setItemsState, hintMap, photoState, setPhotoState }) {
  const setField = (address, field, value) => {
    setItemsState(prev => ({ ...prev, [address]: { ...prev[address], [field]: value } }))
  }

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Icon className="size-4" /> {title}
        {confirmed && <span className="text-xs font-normal text-success">· подтверждено</span>}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          Кладовщик
          <Input value={by} onChange={e => setBy(e.target.value)} placeholder="Иванов И.И." />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Ворота
          <Input value={gate} onChange={e => setGate(e.target.value)} placeholder="№" />
        </label>
        {extra}
      </div>

      {cfzList.length === 0 ? (
        <div className="text-sm text-muted-foreground">ЦФЗ не указаны в маршруте</div>
      ) : (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">РК по ЦФЗ (пусто — запись удалится)</div>
          {cfzList.map(a => {
            const cur = itemsState[a.address] || {}
            const hint = hintMap?.[a.address]
            return (
              <div key={a.address} className="flex flex-wrap items-center gap-2">
                <span className="min-w-32 flex-1 truncate text-sm">{a.address}</span>
                {hint && <span className="text-xs text-muted-foreground">отгр: {hint.rk ?? 0} РК</span>}
                <Input className="w-16" type="number" min="0" placeholder="РК" value={cur.rk ?? ''} onChange={e => setField(a.address, 'rk', e.target.value)} />
                <Input className="w-16" type="number" min="0" placeholder="пал." value={cur.pallets ?? ''} onChange={e => setField(a.address, 'pallets', e.target.value)} />
                <Input className="w-16" type="number" min="0" placeholder="ящ." value={cur.boxes ?? ''} onChange={e => setField(a.address, 'boxes', e.target.value)} />
                <Input className="w-16" type="number" min="0" placeholder="ТЧ" value={cur.thermalCovers ?? ''} onChange={e => setField(a.address, 'thermalCovers', e.target.value)} />
              </div>
            )
          })}
        </div>
      )}

      <PhotoBlock state={photoState} setState={setPhotoState} />
    </div>
  )
}

export default function EditRouteDialog({ route, open, onOpenChange, onSaved }) {
  const [driverName, setDriverName] = useState('')
  const [shipBy, setShipBy] = useState('')
  const [shipGate, setShipGate] = useState('')
  const [shipTempBefore, setShipTempBefore] = useState('')
  const [shipTempAfter, setShipTempAfter] = useState('')
  const [shipRokhlya, setShipRokhlya] = useState('')
  const [recvBy, setRecvBy] = useState('')
  const [recvGate, setRecvGate] = useState('')
  const [recvRokhlya, setRecvRokhlya] = useState('')
  const [shipItems, setShipItems] = useState({})
  const [recvItems, setRecvItems] = useState({})
  const [shipPhotos, setShipPhotos] = useState({ existingPhotos: [], newPhotos: [] })
  const [recvPhotos, setRecvPhotos] = useState({ existingPhotos: [], newPhotos: [] })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open || !route) return
    setDriverName(route.driver?.name || '')
    setShipBy(route.shipment?.by || '')
    setShipGate(route.shipment?.gate || '')
    setShipTempBefore(route.shipment?.tempBefore ?? '')
    setShipTempAfter(route.shipment?.tempAfter ?? '')
    setShipRokhlya(route.shipment?.rokhlya ?? '')
    setRecvBy(route.receiving?.by || '')
    setRecvGate(route.receiving?.gate || '')
    setRecvRokhlya(route.receiving?.rokhlya ?? '')
    setShipItems(itemsToMap(route.shipment?.items))
    setRecvItems(itemsToMap(route.receiving?.items))
    setShipPhotos({ existingPhotos: [...(route.shipment?.photos || [])], newPhotos: [] })
    setRecvPhotos({ existingPhotos: [...(route.receiving?.photos || [])], newPhotos: [] })
  }, [open, route])

  if (!route) return null
  const cfzList = route.cfzAddresses || []

  const collectItems = state => cfzList
    .map(a => {
      const cur = state[a.address]
      const rk = cur?.rk
      if (rk === '' || rk == null) return null
      return {
        address: a.address,
        rk: Number(rk) || 0,
        pallets: Number(cur.pallets) || 0,
        boxes: Number(cur.boxes) || 0,
        thermalCovers: Number(cur.thermalCovers) || 0,
      }
    })
    .filter(Boolean)

  const handleSave = async () => {
    setSaving(true)
    try {
      let shipPhotoUrls = [...shipPhotos.existingPhotos]
      if (shipPhotos.newPhotos.length) {
        const r = await api.uploadRkPhotos(shipPhotos.newPhotos)
        if (r.ok) shipPhotoUrls = [...shipPhotoUrls, ...r.urls]
      }
      let recvPhotoUrls = [...recvPhotos.existingPhotos]
      if (recvPhotos.newPhotos.length) {
        const r = await api.uploadRkPhotos(recvPhotos.newPhotos)
        if (r.ok) recvPhotoUrls = [...recvPhotoUrls, ...r.urls]
      }

      const shipPayload = { by: shipBy, gate: shipGate, tempBefore: shipTempBefore === '' ? null : Number(shipTempBefore), tempAfter: shipTempAfter === '' ? null : Number(shipTempAfter), rokhlya: shipRokhlya === '' ? null : Number(shipRokhlya), items: collectItems(shipItems), photos: shipPhotoUrls }
      const recvPayload = { by: recvBy, gate: recvGate, rokhlya: recvRokhlya === '' ? null : Number(recvRokhlya), items: collectItems(recvItems), photos: recvPhotoUrls }

      let lastRoute = null
      if (driverName.trim() !== (route.driver?.name || '')) {
        const r = await api.updateRkDriver(route.routeId, { name: driverName.trim() })
        if (r.ok) lastRoute = r.route
      }
      if (route.shipment || shipPayload.items.length) {
        const r = await api.updateRkShipment(route.routeId, shipPayload)
        if (r.ok) lastRoute = r.route
      }
      if (route.receiving || recvPayload.items.length) {
        const r = await api.updateRkReceiving(route.routeId, recvPayload)
        if (r.ok) lastRoute = r.route
      }
      if (lastRoute) onSaved(route.routeId, lastRoute)
      toast.success('Маршрут сохранён')
      onOpenChange(false)
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Маршрут {route.routeNumber || '—'}</DialogTitle>
          <DialogDescription>{route.date ? new Date(route.date).toLocaleDateString('ru-RU') : ''}</DialogDescription>
        </DialogHeader>

        <label className="space-y-1 text-xs text-muted-foreground">
          Водитель
          <Input value={driverName} onChange={e => setDriverName(e.target.value)} placeholder="Фамилия И.О." />
        </label>

        <CfzSection
          icon={Truck}
          title="Отгрузка"
          confirmed={route.shipment?.confirmed}
          by={shipBy} setBy={setShipBy}
          gate={shipGate} setGate={setShipGate}
          extra={<>
            <label className="space-y-1 text-xs text-muted-foreground">Темп. до (°C)<Input type="number" value={shipTempBefore} onChange={e => setShipTempBefore(e.target.value)} placeholder="-18" /></label>
            <label className="space-y-1 text-xs text-muted-foreground">Темп. после (°C)<Input type="number" value={shipTempAfter} onChange={e => setShipTempAfter(e.target.value)} placeholder="-18" /></label>
            <label className="space-y-1 text-xs text-muted-foreground">Рохли (отд.)<Input type="number" min="0" value={shipRokhlya} onChange={e => setShipRokhlya(e.target.value)} placeholder="0" /></label>
          </>}
          cfzList={cfzList}
          itemsState={shipItems}
          setItemsState={setShipItems}
          photoState={shipPhotos}
          setPhotoState={setShipPhotos}
        />

        <CfzSection
          icon={PackageOpen}
          title="Приёмка"
          confirmed={route.receiving?.confirmed}
          by={recvBy} setBy={setRecvBy}
          gate={recvGate} setGate={setRecvGate}
          extra={<label className="space-y-1 text-xs text-muted-foreground">Рохли возвр.<Input type="number" min="0" value={recvRokhlya} onChange={e => setRecvRokhlya(e.target.value)} placeholder="0" /></label>}
          cfzList={cfzList}
          itemsState={recvItems}
          setItemsState={setRecvItems}
          hintMap={shipItems}
          photoState={recvPhotos}
          setPhotoState={setRecvPhotos}
        />

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button disabled={saving} onClick={handleSave}>
            {saving ? <Loader2 className="animate-spin" /> : null} Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
