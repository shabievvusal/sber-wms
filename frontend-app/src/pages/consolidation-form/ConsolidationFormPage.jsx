import { useRef, useState } from 'react'
import * as api from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const LS_PREFIX = 'consolidation_storage_prefix'
const LS_ROW = 'consolidation_cell_row'

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
  { value: 'KDS', label: 'KDS', title: 'Сухой' },
  { value: 'KDH', label: 'KDH', title: 'Холод' },
  { value: 'ZGH', label: 'ZGH', title: 'ЦФЗ' },
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
    try { return localStorage.getItem(LS_PREFIX) || 'KDH' } catch { return 'KDH' }
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

  const isZgh = prefix === 'ZGH'
  const cellPreview = prefix + (rowVal || place ? '-' + [rowVal, place].filter(Boolean).join('-') : '-')

  const focusOrder = isZgh
    ? [euBarcodeRef, barcodeRef, photoRef]
    : [rowRef, placeRef, barcodeRef, photoRef]

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
      for (const f of photos) fd.append('photo', f)
      await api.createComplaint(fd)
      try { localStorage.setItem(LS_PREFIX, prefix); localStorage.setItem(LS_ROW, rowVal) } catch { /* ignore */ }
      setStatus({ ok: true, text: 'Жалоба отправлена! Спасибо.' })
      setPlace(''); setBarcode(''); setEuBarcode(''); setPhotos([])
      if (photoRef.current) photoRef.current.value = ''
    } catch (err) {
      setStatus({ ok: false, text: 'Ошибка: ' + err.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-md space-y-4 p-6">
      <div className="text-center">
        <img src="/icon.png" alt="logo" className="mx-auto size-10 object-contain" />
        <div className="mt-1 text-sm font-bold">СберЛогистика</div>
        <div className="text-xs text-muted-foreground">Консолидация</div>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <h1 className="text-lg font-semibold">Сообщить о нарушении</h1>
        <p className="mb-4 text-sm text-muted-foreground">Заполните форму и прикрепите фото</p>

        <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} className="space-y-3">
          <div className="space-y-1.5">
            <span className="text-sm font-medium">Зона</span>
            <div className="grid grid-cols-3 gap-1.5">
              {ZONES.map(z => (
                <button
                  key={z.value}
                  type="button"
                  title={z.title}
                  onClick={() => selectPrefix(z.value)}
                  className={cn(
                    'rounded-md border py-2 text-sm font-medium transition-colors',
                    prefix === z.value ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted',
                  )}
                >
                  {z.label}
                </button>
              ))}
            </div>
          </div>

          {!isZgh && (
            <div className="flex items-end gap-2">
              <label className="flex-1 space-y-1 text-sm">
                <span className="block text-xs text-muted-foreground">Ряд</span>
                <Input ref={rowRef} maxLength={1} inputMode="numeric" value={rowVal} onChange={e => setRowVal(e.target.value)} />
              </label>
              <label className="flex-1 space-y-1 text-sm">
                <span className="block text-xs text-muted-foreground">Место в ряду</span>
                <Input ref={placeRef} maxLength={2} inputMode="numeric" value={place} onChange={e => setPlace(e.target.value)} />
              </label>
            </div>
          )}
          {!isZgh && <div className="text-xs text-muted-foreground">Ячейка: {cellPreview}</div>}

          {isZgh && (
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Штрихкод ЕО</span>
              <Input ref={euBarcodeRef} inputMode="numeric" placeholder="отсканируй или введи ШК ЕО" value={euBarcode} onChange={e => setEuBarcode(e.target.value)} />
            </label>
          )}

          <label className="block space-y-1 text-sm">
            <span className="font-medium">Штрихкод товара{isZgh ? ' (необязательно)' : ''}</span>
            <Input ref={barcodeRef} inputMode="numeric" required={!isZgh} value={barcode} onChange={e => setBarcode(e.target.value)} />
          </label>

          <label className="block space-y-1 text-sm">
            <span className="font-medium">Ваше имя</span>
            <Input value={currentUserName} readOnly className="bg-muted" />
          </label>

          <label className="block space-y-1 text-sm">
            <span className="font-medium">Фото нарушения (можно несколько)</span>
            <input
              ref={photoRef}
              type="file"
              accept="image/*"
              multiple
              onChange={e => setPhotos(Array.from(e.target.files || []))}
              className="w-full text-sm file:mr-3 file:rounded-md file:border file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium"
            />
          </label>

          <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Отправка...' : 'Отправить'}</Button>

          {status && (
            <div className={cn('text-sm', status.ok ? 'text-success' : 'text-destructive')}>{status.text}</div>
          )}
        </form>
      </div>
    </div>
  )
}
