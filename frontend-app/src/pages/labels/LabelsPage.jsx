import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { AlertTriangle, Eraser, Printer } from 'lucide-react'
import { ScanButton } from '@/components/shared/BarcodeScanner'
import { buildCode128Bars, canCode128 } from '@/pages/picking/Code128Barcode'
import { printLabels, textSizeMm } from './labelPrint'

const LS_TEXT = 'labels_text'
const LS_SHOW_TEXT = 'labels_show_text'
const PREVIEW_LIMIT = 24

// полосы штрихкода — как на печати (подпись отдельно, крупно)
function Bars({ value }) {
  const { bars, width } = buildCode128Bars(value)
  return (
    <svg viewBox={`0 0 ${width} 1`} preserveAspectRatio="none" shapeRendering="crispEdges" className="size-full">
      {bars.map((b, i) => <rect key={i} x={b.x} y="0" width={b.width} height="1" fill="#000" />)}
    </svg>
  )
}
const readLs = (k, d) => { try { return localStorage.getItem(k) ?? d } catch { return d } }
const writeLs = (k, v) => { try { localStorage.setItem(k, v) } catch { /* без сохранения */ } }

// «Печать этикеток»: список кодов (вставить, отсканировать сканером или
// камерой — по строке на этикетку) → этикетки 100×75 мм на термопринтере,
// каждая со штрихкодом Code 128 и крупным текстом.
export default function LabelsPage() {
  const [text, setText] = useState(() => readLs(LS_TEXT, ''))
  const [showText, setShowText] = useState(() => readLs(LS_SHOW_TEXT, '1') === '1')
  useEffect(() => { writeLs(LS_TEXT, text) }, [text])
  useEffect(() => { writeLs(LS_SHOW_TEXT, showText ? '1' : '0') }, [showText])

  const lines = useMemo(() => text.split(/\r?\n/).map(s => s.trim()).filter(Boolean), [text])
  const textOnly = useMemo(() => lines.filter(l => !canCode128(l)), [lines])

  const print = () => {
    if (!lines.length) { toast.error('Список пуст — вставьте или отсканируйте коды'); return }
    try { printLabels(lines, { showText }) } catch (err) { toast.error(err.message) }
  }
  const addScanned = t => setText(prev => (prev && !prev.endsWith('\n') ? prev + '\n' : prev) + String(t).trim() + '\n')

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Печать этикеток</h1>
          <p className="text-sm text-muted-foreground">Каждая строка — отдельная этикетка 100 × 75 мм со штрихкодом Code 128</p>
        </div>
        <Button className="ml-auto h-11 px-6 text-base" disabled={!lines.length} onClick={print}>
          <Printer className="size-5" /> Печать{lines.length ? ` (${lines.length})` : ''}
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
        <div className="space-y-2 rounded-2xl border border-line bg-card p-3 shadow-card">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Коды — по одному в строке</span>
            <div className="flex gap-1">
              <ScanButton className="h-9" continuous title="Сканируйте коды подряд" onResult={addScanned} />
              <Button size="sm" variant="ghost" className="h-9" disabled={!text} onClick={() => setText('')} title="Очистить список"><Eraser className="size-4" /></Button>
            </div>
          </div>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            autoFocus
            spellCheck={false}
            placeholder={'Вставьте список из Excel или сканируйте сканером подряд\n012201156725\n012201156724\nKDH-1-12'}
            className="h-[55vh] w-full resize-none rounded-xl border border-input bg-transparent p-3 font-mono text-sm leading-6 outline-none focus:border-primary"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Этикеток: <b className="text-foreground">{lines.length}</b></span>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={showText} onChange={e => setShowText(e.target.checked)} /> текст под штрихкодом
            </label>
          </div>
          {textOnly.length > 0 && (
            <div className="flex gap-2 rounded-xl bg-warning/10 p-2.5 text-xs text-warning">
              <AlertTriangle className="size-4 shrink-0" />
              <span>Строк без штрихкода: {textOnly.length} — Code 128 не умеет кириллицу, они напечатаются только текстом.</span>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="text-sm text-muted-foreground">
            Предпросмотр{lines.length > PREVIEW_LIMIT ? ` — первые ${PREVIEW_LIMIT} из ${lines.length}` : ''}
          </div>
          {!lines.length ? (
            <div className="rounded-2xl border border-dashed p-10 text-center text-sm text-muted-foreground">Здесь появятся этикетки</div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
              {lines.slice(0, PREVIEW_LIMIT).map((l, i) => {
                const coded = canCode128(l)
                return (
                  <div key={`${i}-${l}`} className={cn('flex aspect-[4/3] flex-col items-center justify-center gap-1.5 rounded-xl border bg-white p-3 text-black shadow-card', !coded && 'border-warning')}>
                    {coded && <div className="h-[52%] w-full"><Bars value={l} /></div>}
                    {(showText || !coded) && (
                      <div className="break-all text-center font-bold leading-tight" style={{ fontSize: `${Math.max(9, textSizeMm(l) * 1.6)}px` }}>{l}</div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            В окне печати выберите термопринтер, размер бумаги 100 × 75 мм, масштаб 100% и без полей. Сканер штрихкодов (как на ТСД) можно использовать прямо в поле списка — каждый скан с новой строки.
          </p>
        </div>
      </div>
    </div>
  )
}
