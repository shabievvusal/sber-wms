import { useEffect, useRef, useState } from 'react'
import * as api from '@/lib/api'
import { compressImage } from '@/lib/compressImage'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fmtDate, parseNum, parseTemp } from './format'
import { X } from 'lucide-react'

/** Один плоский `values`-объект { [address]: {rk,pallets,boxes,thermalCovers} }
 * вместо 4 параллельных `useState`-карт оригинала (existingMap/
 * existingPalletsMap/existingBoxesMap/existingThermalCoversMap) — тот же
 * результат, без повторения одной и той же Object.fromEntries четыре раза. */
export function StepData({ opType, route, onDone, byName }) {
  const cfz = route.cfzAddresses || []
  const existingItems = opType === 'ship' ? route.shipment?.items : route.receiving?.items
  const [driverDebt, setDriverDebt] = useState(null)

  useEffect(() => {
    if (opType !== 'receive' || !route.driver?.name) return
    api.getDriverRokhlyaDebt(route.driver.name)
      .then(setDriverDebt)
      .catch(() => setDriverDebt(null))
  }, [opType, route.driver?.name])

  const existingSection = opType === 'ship' ? route.shipment : route.receiving
  const [gate, setGate] = useState(existingSection?.gate || '')
  const [tempBefore, setTempBefore] = useState(existingSection?.tempBefore != null ? String(existingSection.tempBefore) : '')
  const [tempAfter, setTempAfter] = useState(existingSection?.tempAfter != null ? String(existingSection.tempAfter) : '')
  const [rokhlya, setRokhlya] = useState(existingSection?.rokhlya != null ? String(existingSection.rokhlya) : '')

  const [values, setValues] = useState(() => {
    const byAddress = new Map((existingItems || []).map(i => [i.address, i]))
    return Object.fromEntries(cfz.map(a => {
      const ex = byAddress.get(a.address)
      return [a.address, {
        rk: ex?.rk != null ? String(ex.rk) : '',
        pallets: ex?.pallets != null ? String(ex.pallets) : '',
        boxes: ex?.boxes != null ? String(ex.boxes) : '',
        thermalCovers: ex?.thermalCovers != null ? String(ex.thermalCovers) : '',
      }]
    }))
  })
  const setField = (address, field, val) => setValues(prev => ({ ...prev, [address]: { ...prev[address], [field]: val } }))

  const [photos, setPhotos] = useState([]) // { file, url }
  const [status, setStatus] = useState(null)
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef(null)

  const onPhotoSelected = async e => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    const compressed = await Promise.all(files.map(f => compressImage(f)))
    setPhotos(prev => [...prev, ...compressed.map(f => ({ file: f, url: URL.createObjectURL(f) }))])
  }
  const removePhoto = idx => setPhotos(prev => {
    URL.revokeObjectURL(prev[idx].url)
    return prev.filter((_, i) => i !== idx)
  })

  const submit = async () => {
    const items = cfz.map(a => ({
      address: a.address,
      rk: parseNum(values[a.address]?.rk),
      pallets: parseNum(values[a.address]?.pallets),
      boxes: parseNum(values[a.address]?.boxes),
      thermalCovers: parseNum(values[a.address]?.thermalCovers),
    }))

    setSaving(true)
    setStatus(null)

    try {
      let uploadedPhotos = []
      if (photos.length) {
        const res = await api.uploadRkPhotos(photos.map(p => p.file))
        uploadedPhotos = res.urls
      }

      const payload = {
        by: byName || '',
        gate,
        tempBefore: opType === 'ship' ? parseTemp(tempBefore) : null,
        tempAfter: opType === 'ship' ? parseTemp(tempAfter) : null,
        rokhlya: rokhlya !== '' ? Number(rokhlya) : null,
        items,
        photos: uploadedPhotos,
      }

      if (opType === 'ship') await api.submitRkShipment(route.routeId, payload)
      else await api.submitRkReceiving(route.routeId, payload)

      setStatus({ type: 'success', msg: opType === 'ship' ? 'Отгрузка сохранена!' : 'Приёмка сохранена!' })
      setTimeout(onDone, 2000)
    } catch (err) {
      setStatus({ type: 'error', msg: err.message })
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1 rounded-lg border bg-card p-3">
        <div className="font-semibold">{route.routeNumber || '—'}</div>
        <div className="text-sm text-muted-foreground">
          {fmtDate(route.date)}
          {route.driver ? ` · ${route.driver.name}` : ''}
          {route.vehicle ? ` · ${route.vehicle.number}` : ''}
        </div>
        {opType === 'receive' && route.shippedRK != null && (
          <div className="text-sm text-success">Отгружено РК: {route.shippedRK}</div>
        )}
        {opType === 'receive' && driverDebt?.rokhlyaDebt > 0 && (
          <div className="text-sm text-warning-foreground">
            Долг рохлей: {driverDebt.rokhlyaDebt} шт.
            {driverDebt.debtSince && ` · с ${fmtDate(driverDebt.debtSince.date)} (${driverDebt.debtSince.routeNumber})`}
          </div>
        )}
      </div>

      <label className="block space-y-1 text-sm">
        <span className="font-medium">Ворота</span>
        <Input placeholder="Номер ворот" inputMode="numeric" value={gate} onChange={e => setGate(e.target.value)} />
      </label>

      {opType === 'ship' && (
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Темп. ДО отгрузки (°C)</span>
            <Input placeholder="-18" value={tempBefore} onChange={e => setTempBefore(e.target.value)} />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Темп. ПОСЛЕ отгрузки (°C)</span>
            <Input placeholder="-18" value={tempAfter} onChange={e => setTempAfter(e.target.value)} />
          </label>
        </div>
      )}

      <div className="space-y-2">
        <div className="text-sm font-medium">Рохли</div>
        <div className="flex items-center gap-2 rounded-md border bg-card p-2.5">
          <span className="flex-1 text-sm">{opType === 'ship' ? 'Отдано водителю рохлей' : 'Возврат рохлей от водителя'}</span>
          {opType === 'receive' && route.shipment?.rokhlya != null && (
            <span className="text-xs text-muted-foreground">выдано: {route.shipment.rokhlya}</span>
          )}
          <Input className="h-8 w-20 text-right" type="number" inputMode="numeric" min="0" placeholder="0" value={rokhlya} onChange={e => setRokhlya(e.target.value)} />
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium">РК, паллеты, ящики и ТЧ по ЦФЗ</div>
        {cfz.length === 0 && <div className="text-sm text-muted-foreground">Нет адресов ЦФЗ</div>}
        <div className="space-y-2">
          {cfz.map(a => {
            const shipItem = route.shipment?.items?.find(x => x.address === a.address)
            const v = values[a.address] || {}
            return (
              <div key={a.address} className="space-y-1.5 rounded-md border bg-card p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">{a.address}</span>
                  {opType === 'receive' && shipItem && (
                    <span className="text-xs text-muted-foreground">
                      отгр. {shipItem.rk ?? 0} РК{shipItem.pallets ? ` / ${shipItem.pallets} пал.` : ''}{shipItem.boxes ? ` / ${shipItem.boxes} ящ.` : ''}{shipItem.thermalCovers ? ` / ${shipItem.thermalCovers} ТЧ` : ''}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  <Input className="h-8" type="number" inputMode="numeric" min="0" placeholder="РК" value={v.rk ?? ''} onChange={e => setField(a.address, 'rk', e.target.value)} />
                  <Input className="h-8" type="number" inputMode="numeric" min="0" placeholder="пал." value={v.pallets ?? ''} onChange={e => setField(a.address, 'pallets', e.target.value)} />
                  <Input className="h-8" type="number" inputMode="numeric" min="0" placeholder="ящ." value={v.boxes ?? ''} onChange={e => setField(a.address, 'boxes', e.target.value)} />
                  <Input className="h-8" type="number" inputMode="numeric" min="0" placeholder="ТЧ" value={v.thermalCovers ?? ''} onChange={e => setField(a.address, 'thermalCovers', e.target.value)} />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium">Фотографии</div>
        {photos.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {photos.map((p, i) => (
              <div key={i} className="relative">
                <img src={p.url} className="size-20 rounded-md border object-cover" alt="" />
                <button type="button" className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-destructive text-white" onClick={() => removePhoto(i)}>
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()}>+ Добавить фото</Button>
        <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={onPhotoSelected} />
      </div>

      {status && <div className={`text-sm ${status.type === 'success' ? 'text-success' : 'text-destructive'}`}>{status.msg}</div>}
      {status?.type !== 'success' && (
        <Button className="w-full" disabled={saving} onClick={submit}>
          {saving ? 'Сохраняю...' : opType === 'ship' ? 'Сохранить отгрузку' : 'Сохранить приёмку'}
        </Button>
      )}
    </div>
  )
}
