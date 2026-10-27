import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { getStoredToken, syncZgzFromWms } from '@/lib/wmsFetch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DateTimeRangePicker } from '@/components/ui/date-picker'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { Check, CloudDownload, RotateCcw, ScanBarcode, Search, Undo2, X } from 'lucide-react'
import { fmtTime } from './format'
import { LostEoLookup } from './LostEoLookup'

// Режимы: подбор ЕО по товарам внутри; куда кидали товар; что кидали в ячейку.
const MODES = [
  { key: 'match', label: 'Подбор ЕО' },
  { key: 'product', label: 'По товару' },
  { key: 'cell', label: 'По ячейке' },
]

// "YYYY-MM-DDTHH:mm" по Москве
function mskLocal(date) {
  return new Date(date.getTime() + 3 * 3600_000).toISOString().slice(0, 16)
}
const toIso = local => new Date(`${local}:00+03:00`).toISOString()
const fmtMsk = iso => (iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')
const SHOW_LIMIT = 30
const fmtDt = iso => (iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')

// Индекс по выгрузке с сервера ({ products, hus }): ЕО → состав, штрихкод → товары.
function buildIndex(data) {
  const hus = new Map()
  const byBarcode = new Map()
  for (const [pid, p] of Object.entries(data.products || {})) {
    for (const b of p.barcodes || []) {
      if (!byBarcode.has(b)) byBarcode.set(b, { productIds: new Set(), name: p.name, qty: 1 })
      byBarcode.get(b).productIds.add(pid)
    }
    // штрихкоды упаковок: один скан = вложенность (packs: { штрихкод: штук })
    for (const [b, qty] of Object.entries(p.packs || {})) {
      if (byBarcode.has(b)) continue
      byBarcode.set(b, { productIds: new Set([pid]), name: p.name, qty: Number(qty) || 1 })
    }
  }
  for (const h of data.hus || []) {
    const items = new Map()
    let total = 0
    const pickers = new Set()
    let pickedAt = null
    // [товар, штук, кто комплектовал, когда] — см. ZgzService.GetAsync
    for (const [pid, qty, pickedBy, itemPickedAt] of h.items) {
      const p = data.products[pid] || {}
      items.set(pid, { productId: pid, name: p.name, code: p.code, barcodes: p.barcodes || [], qty: Number(qty) || 0, pickedBy: pickedBy || '', pickedAt: itemPickedAt || null })
      total += Number(qty) || 0
      for (const n of (pickedBy || '').split(', ').filter(Boolean)) pickers.add(n)
      if (itemPickedAt && (!pickedAt || itemPickedAt > pickedAt)) pickedAt = itemPickedAt
    }
    hus.set(h.hu, { ...h, items, total, pickedBy: [...pickers].join(', '), pickedAt })
  }
  return { hus, byBarcode }
}

// Штрихкод товара из скана: как есть, затем UPC-A (12) ↔ EAN-13 с ведущим нулём.
function resolveBarcode(index, raw) {
  const code = String(raw || '').trim()
  for (const c of [code, '0' + code, code.replace(/^0/, '')]) {
    if (c && index.byBarcode.has(c)) return { code: c, ...index.byBarcode.get(c) }
  }
  return null
}
const productKey = ids => [...ids].sort().join('|')

// Страница «Поиск потеряшек»: ночная смена переводит в ЗГЗ все ЕО (в т.ч.
// физически потерянные), после чего найденную ЕО без опознания подбирают
// по товарам внутри — сканируя штрихкоды. Каждый скан оставляет только ЕО,
// где этот товар есть в нужном количестве (3 скана одного товара — ЕО, где
// его ≥ 3). Переводы хранятся на сервере (ZgzService) — к ним можно
// возвращаться; «Обновить из WMS» только дозагружает новые.
export default function LostEoPage() {
  const now = new Date()
  const [range, setRange] = useState({ from: mskLocal(new Date(now.getTime() - 12 * 3600_000)), to: mskLocal(now) })
  const [data, setData] = useState(null)
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState(null)
  const [scans, setScans] = useState([]) // [{ code, productIds:Set, name }]
  const [input, setInput] = useState('')
  const [mode, setMode] = useState('match')
  // ячейка КДК → ЦФЗ (Настройки → «ЦФЗ по ячейкам КДК»)
  const [cellStores, setCellStores] = useState(new Map())
  const inputRef = useRef(null)

  const index = useMemo(() => (data ? buildIndex(data) : null), [data])

  const loadInfo = () => api.getZgzInfo().then(setInfo).catch(() => {})

  const show = async (r = range) => {
    if (!r.from || !r.to) { toast.error('Укажите период перевода в ЗГЗ'); return }
    setLoading(true)
    try {
      const res = await api.getZgzMoves(toIso(r.from), toIso(r.to))
      setData(res)
      setScans([])
      setTimeout(() => inputRef.current?.focus(), 50)
    } catch (err) {
      toast.error('Не удалось загрузить с сервера: ' + (err.message || err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadInfo()
    show()
    api.getCellStores().then(r => setCellStores(new Map((r?.cells || []).map(c => [c.address, c.storeName])))).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const syncFromWms = async () => {
    const token = getStoredToken()
    if (!token) { toast.error('Нет активного WMS-токена — войдите паролем от WMS'); return }
    if (!range.from || !range.to) { toast.error('Укажите период перевода в ЗГЗ'); return }
    setSyncing(true)
    setProgress(null)
    try {
      const res = await syncZgzFromWms(token, { from: toIso(range.from), to: toIso(range.to), onProgress: setProgress })
      toast.success(`Из WMS: строк ${res.fetched.toLocaleString('ru-RU')}, новых на сервере ${res.added.toLocaleString('ru-RU')}`)
      await loadInfo()
      await show()
    } catch (err) {
      toast.error('Не удалось загрузить из WMS: ' + (err.message || err))
    } finally {
      setSyncing(false)
    }
  }

  // сколько раз отсканирован каждый товар (по набору productId штрихкода)
  const scanCounts = useMemo(() => {
    const m = new Map()
    for (const s of scans) {
      const key = productKey(s.productIds)
      const cur = m.get(key) || { productIds: s.productIds, name: s.name, code: s.code, count: 0 }
      cur.count += s.qty || 1
      m.set(key, cur)
    }
    return [...m.values()]
  }, [scans])

  // ЕО-кандидаты: по каждому отсканированному товару в ЕО не меньше штук, чем сканов.
  // Сначала ЕО, где меньше «лишних» товаров (полнее совпадение).
  const candidates = useMemo(() => {
    if (!index) return []
    const list = []
    for (const hu of index.hus.values()) {
      let ok = true
      for (const s of scanCounts) {
        let have = 0
        for (const id of s.productIds) have += hu.items.get(id)?.qty || 0
        if (have < s.count) { ok = false; break }
      }
      if (ok) list.push(hu)
    }
    return list.sort((a, b) => a.total - b.total || (a.hu < b.hu ? -1 : 1))
  }, [index, scanCounts])

  const handleScan = e => {
    e.preventDefault()
    const raw = input.trim()
    setInput('')
    if (!raw || !index) return
    // отсканировали саму этикетку ЕО
    if (index.hus.has(raw)) {
      const hu = index.hus.get(raw)
      const store = cellStores.get(hu.sourceCell)
      toast.success(`ЕО ${raw}: прибита в ${hu.targetCell || '—'}, из ${hu.sourceCell || '—'}${store ? ` · ЦФЗ ${store}` : ''}`)
      return
    }
    const found = resolveBarcode(index, raw)
    if (!found) { toast.error(`Штрихкод ${raw} не найден в переводах в ЗГЗ за выбранный период`); return }
    setScans(prev => [...prev, { code: found.code, productIds: found.productIds, name: found.name, qty: found.qty || 1 }])
    if (found.qty > 1) toast.info(`Штрихкод упаковки — засчитано ${found.qty} шт.`)
  }

  const undo = () => { setScans(prev => prev.slice(0, -1)); inputRef.current?.focus() }
  const removeProduct = s => {
    const key = productKey(s.productIds)
    setScans(prev => prev.filter(x => productKey(x.productIds) !== key))
    inputRef.current?.focus()
  }

  const scannedIds = useMemo(() => {
    const m = new Map()
    for (const s of scanCounts) for (const id of s.productIds) m.set(id, (m.get(id) || 0) + s.count)
    return m
  }, [scanCounts])

  const huCount = index?.hus.size || 0
  const single = scans.length > 0 && candidates.length === 1
  const busy = loading || syncing

  return (
    <div className="mx-auto w-full space-y-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Поиск потеряшек</h1>
        <p className="text-sm text-muted-foreground">
          Сканируйте штрихкоды товаров из найденной ЕО — с каждым сканом подходящих ЕО из переводов в ЗГЗ становится меньше
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-card p-3 shadow-card">
        <span className="text-xs text-muted-foreground">Перевод в ЗГЗ:</span>
        <DateTimeRangePicker className="h-9 w-80" from={range.from} to={range.to} onChange={r => r.from && setRange(r)} disabled={busy} placeholder="Период перевода" />
        <Button variant="secondary" onClick={() => show()} disabled={busy}>
          <Search className="size-4" /> {loading ? 'Загрузка…' : 'Показать'}
        </Button>
        <Button variant="outline" onClick={syncFromWms} disabled={busy} title="Загрузить переводы за период из WMS и сохранить на сервер">
          <CloudDownload className="size-4" /> {syncing ? 'Загрузка из WMS…' : 'Обновить из WMS'}
        </Button>
        {syncing && progress && (
          <span className="text-xs text-muted-foreground">
            {progress.stage === 'save' ? 'сохранение' : 'WMS'}: {progress.loaded.toLocaleString('ru-RU')} из {progress.total.toLocaleString('ru-RU')}
          </span>
        )}
        {info && (
          <span className="ml-auto text-xs text-muted-foreground">
            {info.rows ? `На сервере: ЕО ${info.hus.toLocaleString('ru-RU')} · переводы ${fmtMsk(info.from)} — ${fmtMsk(info.to)}` : 'На сервере пока пусто — нажмите «Обновить из WMS»'}
          </span>
        )}
      </div>

      {busy && !index && <Spinner label="Загрузка переводов в ЗГЗ…" />}

      {index && (
        <div className="flex w-fit gap-1 rounded-md border bg-muted/30 p-0.5">
          {MODES.map(m => (
            <Button key={m.key} size="sm" className="h-8 px-4" variant={mode === m.key ? 'default' : 'ghost'} onClick={() => setMode(m.key)}>{m.label}</Button>
          ))}
        </div>
      )}

      {index && mode !== 'match' && (
        <LostEoLookup
          key={mode}
          mode={mode}
          index={index}
          cellStores={cellStores}
          resolveBarcode={resolveBarcode}
          periodLabel={`Переводы в ЗГЗ: ${range.from.replace('T', ' ')} — ${range.to.replace('T', ' ')} (МСК)`}
        />
      )}

      {index && mode === 'match' && (
        <>
          <form onSubmit={handleScan} className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-card p-3 shadow-card">
            <ScanBarcode className="size-5 text-muted-foreground" />
            <Input
              ref={inputRef}
              autoFocus
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Сканируйте штрихкод товара"
              className="h-10 max-w-sm text-base"
              inputMode="numeric"
            />
            <Button type="submit" variant="secondary">Добавить</Button>
            <Button type="button" variant="ghost" onClick={undo} disabled={!scans.length}><Undo2 className="size-4" /> Отменить скан</Button>
            <Button type="button" variant="ghost" onClick={() => { setScans([]); inputRef.current?.focus() }} disabled={!scans.length}><RotateCcw className="size-4" /> Сбросить</Button>
            <span className={cn('ml-auto rounded-full px-3 py-1 text-sm font-semibold', single ? 'bg-success/15 text-success' : scans.length && candidates.length === 0 ? 'bg-destructive/10 text-destructive' : 'bg-muted')}>
              {scans.length ? `Подходит ЕО: ${candidates.length.toLocaleString('ru-RU')}` : `ЕО за период: ${huCount.toLocaleString('ru-RU')}`}
            </span>
          </form>

          {huCount === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">За этот период переводов на сервере нет — нажмите «Обновить из WMS»</div>
          )}

          {scanCounts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {scanCounts.map(s => (
                <span key={productKey(s.productIds)} className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs">
                  <span className="max-w-72 truncate" title={s.name}>{s.name || s.code}</span>
                  <span className="font-semibold">× {s.count}</span>
                  <button type="button" className="opacity-60 hover:opacity-100" onClick={() => removeProduct(s)} title="Убрать товар из поиска"><X className="size-3.5" /></button>
                </span>
              ))}
            </div>
          )}

          {scans.length > 0 && candidates.length === 0 && (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
              Ни одна ЕО не подходит под все сканы. Проверьте последний скан («Отменить скан») или расширьте период и обновите из WMS.
            </div>
          )}

          {scans.length > 0 && candidates.length > 0 && (
            <div className="space-y-3">
              {candidates.length > SHOW_LIMIT && (
                <div className="text-sm text-muted-foreground">Показаны первые {SHOW_LIMIT} из {candidates.length.toLocaleString('ru-RU')} — сканируйте ещё товары, чтобы сузить поиск</div>
              )}
              {candidates.slice(0, SHOW_LIMIT).map(hu => (
                <div key={hu.hu} className={cn('rounded-2xl border bg-card p-4 shadow-card', single && 'border-success ring-2 ring-success/30')}>
                  <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
                    <div>
                      <div className="text-xs text-muted-foreground">ЕО</div>
                      <div className="font-mono text-xl font-semibold tracking-wide">{hu.hu}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Прибита в ЗГЗ</div>
                      <div className="text-lg font-semibold">{hu.targetCell || '—'}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Из ячейки КДК</div>
                      <div className="text-lg font-semibold">{hu.sourceCell || '—'}</div>
                    </div>
                    {cellStores.get(hu.sourceCell) && (
                      <div>
                        <div className="text-xs text-muted-foreground">ЦФЗ</div>
                        <div className="text-lg font-semibold">{cellStores.get(hu.sourceCell)}</div>
                      </div>
                    )}
                    <div className="text-sm text-muted-foreground">
                      скомплектовал {hu.pickedBy || '—'}{hu.pickedAt ? ` · ${fmtTime(hu.pickedAt)}` : ''} · перевёл {hu.executor || '—'} · {fmtTime(hu.completedAt)} · товаров в ЕО: {hu.total}
                    </div>
                  </div>
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-muted-foreground">
                          <th className="py-1 pr-3 font-normal">Товар</th>
                          <th className="py-1 pr-3 font-normal">Штрихкод</th>
                          <th className="py-1 pr-3 text-center font-normal">В ЕО</th>
                          <th className="py-1 pr-3 font-normal">Кто комплектовал</th>
                          <th className="py-1 pr-3 font-normal">Дата комплектации</th>
                          <th className="py-1 text-center font-normal">Отсканировано</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...hu.items.values()].sort((a, b) => (scannedIds.get(b.productId) || 0) - (scannedIds.get(a.productId) || 0)).map(it => {
                          const sc = scannedIds.get(it.productId) || 0
                          return (
                            <tr key={it.productId} className={cn('border-t', sc > 0 && 'bg-success/5')}>
                              <td className="py-1 pr-3">{it.name || it.code}</td>
                              <td className="py-1 pr-3 font-mono text-xs text-muted-foreground">{it.barcodes[0] || '—'}</td>
                              <td className="py-1 pr-3 text-center tabular-nums">{it.qty}</td>
                              <td className="py-1 pr-3">{it.pickedBy || '—'}</td>
                              <td className="py-1 pr-3 whitespace-nowrap">{it.pickedAt ? fmtDt(it.pickedAt) : '—'}</td>
                              <td className="py-1 text-center tabular-nums">
                                {sc > 0 ? <span className="inline-flex items-center gap-1 font-semibold text-success"><Check className="size-3.5" />{sc}</span> : '—'}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
