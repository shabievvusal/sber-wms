import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from '@/lib/api'
import { compressPhoto } from '@/lib/compressImage'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Camera, CheckCircle2, Loader2, X } from 'lucide-react'

const LS_PREFIX = 'consolidation_storage_prefix'
const LS_ROW = 'consolidation_cell_row'
const MAX_PHOTOS = 10

// «Иванов Иван Иванович» → «Иванов И.И.» — как в оригинале (utils/format.js),
// дублируется локально по устоявшемуся в проекте принципу (см. PLAN.md —
// мелкие форматтеры не выносятся в общий модуль между разделами).
function shortFio(name) {
  if (!name) return ''
  const parts = String(name).trim().split(/\s+/)
  if (parts.length < 2) return name
  const last = parts[0]
  const initials = parts.slice(1).map(p => p[0] ? p[0].toUpperCase() + '.' : '').join('')
  return last + ' ' + initials
}

const ZONES = [
  { value: 'KDH', label: 'KDH', title: 'Холод' },
  { value: 'ZGH', label: 'ZGH', title: 'ЗГЗ' },
]

// Перенесено из оригинала (frontend/app/src/pages/consolidation/
// ConsolidationFormPage.jsx) — кио­ск-форма подачи жалобы, «производящий»
// конец воркфлоу, чей «потребитель» — уже перенесённая ConsolidationPage
// (там же ссылка «Форма для сотрудников» ведёт сюда). Заполняет только
// сырые факты (ячейка/штрихкод/фото) — кто нарушитель, определяется позже
// WMS-поиском на стороне ConsolidationPage, эта форма о нём вообще не знает.
//
// В оригинале это отдельный роут без Layout/сайдбара (как ReceivePage) —
// здесь тот же принцип, что и у ReceivePage: не в NAV_ITEMS, доступ только
// через ссылку из ConsolidationPage, но по-прежнему внутри общей оболочки
// песочницы (в ней нет отдельных «безрамочных» роутов вообще, см. PLAN.md
// про ReceivePage).
export default function ConsolidationFormPage() {
  const { user } = useAuth()
  const currentUserName = user?.name ? shortFio(user.name) : ''
  const [prefix, setPrefix] = useState(() => {
    // запомненная зона, которой больше нет (KDS), — по умолчанию KDH
    try { const v = localStorage.getItem(LS_PREFIX); return ZONES.some(z => z.value === v) ? v : 'KDH' } catch { return 'KDH' }
  })
  const [rowVal, setRowVal] = useState(() => {
    try { return localStorage.getItem(LS_ROW) || '' } catch { return '' }
  })
  const [place, setPlace] = useState('')
  const [barcode, setBarcode] = useState('')
  const [euBarcode, setEuBarcode] = useState('')
  const [photos, setPhotos] = useState([])
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)

  const rowRef = useRef(null)
  const placeRef = useRef(null)
  const barcodeRef = useRef(null)
  const euBarcodeRef = useRef(null)
  const photoRef = useRef(null)

  const previews = useMemo(() => photos.map(f => URL.createObjectURL(f)), [photos])
  useEffect(() => () => previews.forEach(u => URL.revokeObjectURL(u)), [previews])
  const addPhotos = e => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    setPhotos(prev => [...prev, ...files].slice(0, MAX_PHOTOS))
  }
  const removePhoto = i => setPhotos(prev => prev.filter((_, j) => j !== i))

  const isZgh = prefix === 'ZGH'
  const cellPreview = prefix + (rowVal || place ? '-' + [rowVal, place].filter(Boolean).join('-') : '-')

  const focusOrder = isZgh
    ? [euBarcodeRef, barcodeRef]
    : [rowRef, placeRef, barcodeRef]

  const handleKeyDown = e => {
    if (e.key !== 'Enter') return
    const idx = focusOrder.findIndex(r => r.current === e.target)
    if (idx === -1) return
    e.preventDefault()
    const next = focusOrder[idx + 1] || focusOrder[0]
    next.current?.focus()
  }

  const selectPrefix = p => {
    setPrefix(p)
    try { localStorage.setItem(LS_PREFIX, p) } catch { /* ignore */ }
  }

  const handleSubmit = async e => {
    e.preventDefault()
    setStatus(null)

    let cell
    if (isZgh) {
      if (!euBarcode.trim()) { setStatus({ ok: false, text: 'Отсканируйте или введите штрихкод ЕО' }); return }
      cell = 'ZGH'
    } else {
      if (!rowVal.trim() || !place.trim()) { setStatus({ ok: false, text: 'Введите ряд и место в ряду' }); return }
      cell = `${prefix}-${rowVal.trim()}-${place.trim()}`
    }

    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('cell', cell)
      fd.append('barcode', barcode.trim())
      fd.append('employeeName', currentUserName)
      if (isZgh) fd.append('handlingUnitBarcode', euBarcode.trim())
      // сжимаем на телефоне: на сервер уходят ~200 КБ вместо 3–8 МБ на фото
      if (photos.length) setStatus({ ok: true, text: 'Сжимаем фото…' })
      for (const f of photos) {
        const { photo, thumb } = await compressPhoto(f)
        fd.append('photo', photo, 'photo.jpg')
        fd.append('thumb', thumb, 'thumb.jpg')
      }
      if (photos.length) setStatus({ ok: true, text: 'Отправляем…' })
      await api.createComplaint(fd)
      try { localStorage.setItem(LS_PREFIX, prefix); localStorage.setItem(LS_ROW, rowVal) } catch { /* ignore */ }
      setStatus({ ok: true, done: true, text: 'Жалоба отправлена' })
      setPlace(''); setBarcode(''); setEuBarcode(''); setPhotos([])
    } catch (err) {
      setStatus({ ok: false, text: 'Ошибка: ' + err.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-md space-y-4 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <img src="/icon.png" alt="" className="size-10 object-contain" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Сообщить о нарушении</h1>
          <div className="text-xs text-muted-foreground">Консолидация · {currentUserName || 'сотрудник'}</div>
        </div>
      </div>

      {status?.ok && status.done ? (
        <div className="space-y-4 rounded-3xl border border-success/30 bg-success/10 p-6 text-center shadow-card">
          <CheckCircle2 className="mx-auto size-12 text-success" />
          <div className="text-lg font-semibold">Жалоба отправлена</div>
          <div className="text-sm text-muted-foreground">Спасибо! Нарушителя найдут по WMS.</div>
          <Button className="h-12 w-full text-base" onClick={() => { setStatus(null); setTimeout(() => (isZgh ? euBarcodeRef : placeRef).current?.focus(), 50) }}>Ещё одна жалоба</Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} className="space-y-4 rounded-3xl border border-line bg-card p-4 shadow-card">
          <div className="grid grid-cols-2 gap-2">
            {ZONES.map(z => (
              <button key={z.value} type="button" onClick={() => selectPrefix(z.value)}
                className={cn('rounded-2xl border p-3 text-left transition-colors', prefix === z.value ? 'border-primary bg-primary text-primary-foreground' : 'border-line bg-card hover:bg-muted')}>
                <div className="text-lg font-semibold">{z.label}</div>
                <div className={cn('text-xs', prefix === z.value ? 'text-primary-foreground/80' : 'text-muted-foreground')}>{z.title}</div>
              </button>
            ))}
          </div>

          {!isZgh ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className="block text-xs font-medium text-muted-foreground">Ряд</span>
                  <Input ref={rowRef} maxLength={1} inputMode="numeric" className="h-12 text-center text-lg" value={rowVal} onChange={e => setRowVal(e.target.value)} />
                </label>
                <label className="space-y-1">
                  <span className="block text-xs font-medium text-muted-foreground">Место в ряду</span>
                  <Input ref={placeRef} maxLength={2} inputMode="numeric" className="h-12 text-center text-lg" value={place} onChange={e => setPlace(e.target.value)} />
                </label>
              </div>
              <div className="flex items-center justify-between rounded-2xl bg-muted/60 px-3 py-2">
                <span className="text-xs text-muted-foreground">Ячейка</span>
                <span className="font-mono text-base font-semibold">{cellPreview}</span>
              </div>
            </div>
          ) : (
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Штрихкод ЕО</span>
              <Input ref={euBarcodeRef} inputMode="numeric" className="h-12 text-lg" placeholder="Отсканируйте ЕО" value={euBarcode} onChange={e => setEuBarcode(e.target.value)} />
            </label>
          )}

          <label className="block space-y-1">
            <span className="block text-xs font-medium text-muted-foreground">Штрихкод товара{isZgh ? ' (необязательно)' : ''}</span>
            <Input ref={barcodeRef} inputMode="numeric" className="h-12 text-lg" placeholder="Отсканируйте товар" required={!isZgh} value={barcode} onChange={e => setBarcode(e.target.value)} />
          </label>

          <div className="space-y-2">
            <span className="block text-xs font-medium text-muted-foreground">Фото нарушения</span>
            <div className="grid grid-cols-3 gap-2">
              {previews.map((url, i) => (
                <div key={url} className="relative aspect-square overflow-hidden rounded-2xl border border-line">
                  <img src={url} alt="" className="size-full object-cover" />
                  <button type="button" onClick={() => removePhoto(i)} className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white" title="Убрать фото"><X className="size-3.5" /></button>
                </div>
              ))}
              {photos.length < MAX_PHOTOS && (
                <button type="button" onClick={() => photoRef.current?.click()}
                  className="flex aspect-square flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-line text-muted-foreground hover:border-primary hover:text-primary">
                  <Camera className="size-6" />
                  <span className="text-xs">{photos.length ? 'Ещё фото' : 'Добавить фото'}</span>
                </button>
              )}
            </div>
            <input ref={photoRef} type="file" accept="image/*" multiple className="hidden" onChange={addPhotos} />
          </div>

          <Button type="submit" className="h-12 w-full text-base" disabled={busy}>
            {busy ? <><Loader2 className="size-4 animate-spin" /> {status?.text || 'Отправка…'}</> : 'Отправить жалобу'}
          </Button>

          {status && !status.ok && <div className="rounded-2xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{status.text}</div>}
        </form>
      )}
    </div>
  )
}
