import { useCallback, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { getStoredToken, findProductsByBarcode, fetchProductStock, getEoPicking } from '@/lib/wmsFetch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { Code128Barcode, schedulePrint } from './Code128Barcode'
import { DoorOpen, Loader2, Package, Printer, Search, UserRound } from 'lucide-react'
import { shortFio, mapLimit } from './format'
import { ScanButton } from '@/components/shared/BarcodeScanner'

const STOCK_STATUS = {
  RESERVED_FOR_SHIPMENT: 'Резерв под отгрузку',
  AVAILABLE: 'Доступен',
  RESERVED: 'Зарезервирован',
  BLOCKED: 'Заблокирован',
}
// ворота — ячейки G<номер> (зона «Ворота 147»)
const isGate = s => /^G\d+$/i.test(s.cell) || /^ворота/i.test(s.zone)
const fmtD = d => (d ? d.split('-').reverse().join('.') : '—')
const fmtQty = v => Number(v || 0).toLocaleString('ru-RU')
const fio = u => [u?.lastName, u?.firstName, u?.middleName].filter(Boolean).join(' ')
const fmtTime = iso => (iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')
const ACTIVE_MIN = 30 // последний отбор не старше — «комплектуется сейчас»

// Кто комплектует из ЕО (операции, где ЕО — источник)
function PickingInfo({ info }) {
  if (!info || info === 'loading') return <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Проверяем комплектацию…</div>
  if (info.error) return <div className="text-xs text-destructive">Комплектация: {info.error}</div>
  if (!info.total) return <div className="text-xs text-muted-foreground">Из ЕО ещё не отбирали</div>
  const minAgo = info.lastAt ? Math.round((Date.now() - new Date(info.lastAt).getTime()) / 60000) : null
  const active = minAgo != null && minAgo <= ACTIVE_MIN
  const [last, ...rest] = info.pickers
  return (
    <div className="space-y-1.5 rounded-xl border border-line p-2.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className={cn('rounded-full px-2 py-0.5 font-medium', active ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground')}>
          {active ? 'Комплектуется' : 'Комплектовали'}
        </span>
        <span className="text-muted-foreground">{minAgo != null && minAgo < 120 ? `${minAgo} мин назад` : fmtTime(info.lastAt)}</span>
      </div>
      {last && (
        <div className="flex items-center gap-1.5 text-sm">
          <UserRound className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">{fio(last.user) || '—'}</span>
          <span className="text-xs text-muted-foreground">· отборов {last.count}</span>
        </div>
      )}
      {rest.length > 0 && (
        <div className="text-xs text-muted-foreground">ещё: {rest.map(r => `${shortFio(fio(r.user))} (${r.count})`).join(', ')}</div>
      )}
      <div className="text-xs text-muted-foreground">отобрано {fmtQty(info.picked)} шт{info.complete ? '' : ` за последние 500 из ${fmtQty(info.total)} операций`}</div>
    </div>
  )
}

// «Поиск ЕО»: по ШК товара — где он сейчас стоит на воротах и в каких ЕО.
// ШК → товар (products/search) → остатки товара по ячейкам и ЕО
// (stocks/v2/details) → строки на воротах. Номер ЕО можно распечатать
// штрихкодом Code 128.
export default function EoSearchPage() {
  const [barcode, setBarcode] = useState('')
  const [result, setResult] = useState(null) // { barcode, products: [{ ...product, stock }] }
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [printValue, setPrintValue] = useState('')
  const [picking, setPicking] = useState({}) // ЕО → 'loading' | info | { error }

  const print = useCallback(value => {
    if (!value) return
    setPrintValue(value)
    schedulePrint()
  }, [])

  // value — штрихкод с камеры (иначе — из поля)
  const search = async value => {
    const clean = (typeof value === 'string' ? value : barcode).replace(/\s/g, '')
    if (!clean) { setError('Введите или отсканируйте ШК товара'); return }
    const token = getStoredToken()
    if (!token) { setError('Нет активного WMS-токена — войдите паролем от WMS'); return }
    setError('')
    setLoading(true)
    setResult(null)
    setShowAll(false)
    setPicking({})
    try {
      const products = await findProductsByBarcode(token, clean)
      const withStock = await Promise.all(products.map(async p => ({ ...p, stock: await fetchProductStock(getStoredToken() || token, p.id) })))
      setResult({ barcode: clean, products: withStock })
      // кто комплектует — по ЕО на воротах, по 4 запроса одновременно
      const eos = [...new Set(withStock.flatMap(p => p.stock.filter(isGate).map(x => x.eo)).filter(Boolean))]
      setPicking(Object.fromEntries(eos.map(e => [e, 'loading'])))
      mapLimit(eos, 4, async eo => {
        const info = await getEoPicking(getStoredToken() || token, eo).catch(err => ({ error: err.message || 'ошибка WMS' }))
        setPicking(prev => ({ ...prev, [eo]: info }))
      })
    } catch (err) {
      setError(err.message || 'Ошибка поиска')
    } finally {
      setLoading(false)
    }
  }

  const summary = useMemo(() => {
    if (!result) return null
    const all = result.products.flatMap(p => p.stock.map(s => ({ ...s, product: p })))
    const gates = all.filter(isGate).sort((a, b) => a.cell.localeCompare(b.cell, 'ru', { numeric: true }) || a.eo.localeCompare(b.eo))
    const other = all.filter(s => !isGate(s)).sort((a, b) => a.zone.localeCompare(b.zone, 'ru') || a.cell.localeCompare(b.cell, 'ru', { numeric: true }))
    return { gates, other, gateQty: gates.reduce((s, x) => s + x.quantity, 0), gateCount: new Set(gates.map(g => g.cell)).size }
  }, [result])

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Поиск ЕО</h1>
        <p className="text-sm text-muted-foreground">Отсканируйте ШК товара — покажем, на каких воротах он стоит и в каких ЕО</p>
      </div>

      <form onSubmit={e => { e.preventDefault(); search() }} className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-card p-3 shadow-card">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-11 pl-9 text-base" autoFocus inputMode="numeric" value={barcode}
            onChange={e => setBarcode(e.target.value.replace(/\s/g, ''))} placeholder="ШК товара" />
        </div>
        <ScanButton className="h-11 w-12" title="Штрихкод товара" onResult={t => { const v = String(t).replace(/\s/g, ''); setBarcode(v); search(v) }} />
        <Button type="submit" className="h-11" disabled={loading}>{loading ? 'Ищем…' : 'Найти'}</Button>
      </form>

      {error && <div className="rounded-2xl bg-destructive/10 px-4 py-2.5 text-sm text-destructive">{error}</div>}
      {loading && <Spinner label="Ищем товар и его остатки…" />}

      {!loading && result && !result.products.length && (
        <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">Товар со штрихкодом <span className="font-mono">{result.barcode}</span> в WMS не найден</div>
      )}

      {!loading && result?.products.length > 0 && summary && (
        <>
          {/* товар */}
          {result.products.map(p => (
            <div key={p.id} className="flex items-center gap-3 rounded-2xl border border-line bg-card p-3 shadow-card">
              {p.imageUrl
                ? <img src={p.imageUrl} alt="" className="size-16 shrink-0 rounded-xl bg-white object-contain" />
                : <div className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-muted"><Package className="size-6 text-muted-foreground" /></div>}
              <div className="min-w-0">
                <div className="font-medium">{p.name}</div>
                <div className="font-mono text-xs text-muted-foreground">{p.code} · ШК {result.barcode}</div>
              </div>
            </div>
          ))}

          {/* на воротах */}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <div className="flex items-center gap-2 text-base font-semibold"><DoorOpen className="size-5 text-primary" /> На воротах</div>
            <span className="text-sm text-muted-foreground">
              {summary.gates.length ? `ЕО ${summary.gates.length} · ворот ${summary.gateCount} · ${fmtQty(summary.gateQty)} шт` : 'нет'}
            </span>
          </div>

          {!summary.gates.length ? (
            <div className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              На воротах этого товара сейчас нет{summary.other.length ? ' — остатки в других ячейках ниже' : ''}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {summary.gates.map(s => (
                <div key={`${s.cell}-${s.eo}`} className="space-y-3 rounded-2xl border border-line bg-card p-4 shadow-card">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-xs text-muted-foreground">ЕО</div>
                      <div className="font-mono text-xl font-semibold tracking-wide">{s.eo || '—'}</div>
                    </div>
                    {s.eo && (
                      <Button size="sm" variant="outline" onClick={() => print(s.eo)} title="Печать штрихкода ЕО (Code 128)"><Printer className="size-3.5" /> Печать</Button>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-xl bg-primary/10 py-2">
                      <div className="text-[11px] text-muted-foreground">Ворота</div>
                      <div className="text-lg font-semibold text-primary">{s.cell}</div>
                    </div>
                    <div className="rounded-xl bg-muted/60 py-2">
                      <div className="text-[11px] text-muted-foreground">Штук</div>
                      <div className="tabular text-lg font-semibold">{fmtQty(s.quantity)}</div>
                    </div>
                    <div className="rounded-xl bg-muted/60 py-2">
                      <div className="text-[11px] text-muted-foreground">Годен до</div>
                      <div className="text-sm font-semibold leading-7">{fmtD(s.bestBeforeDate)}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
                    <span>{STOCK_STATUS[s.status] || s.status || '—'}</span>
                    <span>произведён {fmtD(s.productionDate)}</span>
                  </div>
                  {s.eo && <PickingInfo info={picking[s.eo]} />}
                  {result.products.length > 1 && <div className="truncate text-xs text-muted-foreground">{s.product.name}</div>}
                </div>
              ))}
            </div>
          )}

          {/* остальной остаток */}
          {summary.other.length > 0 && (
            <div className="space-y-2">
              <button type="button" onClick={() => setShowAll(v => !v)} className="text-sm font-medium text-primary">
                {showAll ? 'Скрыть' : 'Показать'} остаток в других ячейках ({summary.other.length})
              </button>
              {showAll && (
                <div className="overflow-hidden rounded-2xl border border-line bg-card shadow-card">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-xs text-muted-foreground">
                        <th className="px-3 py-2 text-left font-normal">Ячейка</th>
                        <th className="px-3 py-2 text-left font-normal">Зона</th>
                        <th className="px-3 py-2 text-left font-normal">ЕО</th>
                        <th className="px-3 py-2 text-center font-normal">Штук</th>
                        <th className="hidden px-3 py-2 text-center font-normal sm:table-cell">Годен до</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.other.map((s, i) => (
                        <tr key={`${s.cell}-${s.eo}-${i}`} className="border-b border-line last:border-0">
                          <td className="px-3 py-1.5 font-mono text-xs font-semibold">{s.cell || '—'}</td>
                          <td className="px-3 py-1.5 text-xs text-muted-foreground">{s.zone || '—'}</td>
                          <td className="px-3 py-1.5 font-mono text-xs">{s.eo || '—'}</td>
                          <td className="px-3 py-1.5 text-center tabular-nums">{fmtQty(s.quantity)}</td>
                          <td className="hidden px-3 py-1.5 text-center text-xs sm:table-cell">{fmtD(s.bestBeforeDate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {!loading && !result && !error && (
        <div className={cn('rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground')}>Введите или отсканируйте ШК товара</div>
      )}

      <style>{`
        @media print { body.eo-printing #root { display: none !important; } body.eo-printing .eo-print-portal { display: flex !important; } }
        .eo-print-portal { display: none; align-items: center; justify-content: center; height: 100vh; }
      `}</style>
      {createPortal(
        <div className="eo-print-portal">{printValue && <Code128Barcode value={printValue} className="h-32 w-80" />}</div>,
        document.body,
      )}
    </div>
  )
}
