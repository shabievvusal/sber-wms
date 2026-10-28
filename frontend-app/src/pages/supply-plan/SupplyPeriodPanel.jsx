import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { getStoredToken, fetchInboundAroundDate } from '@/lib/wmsFetch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DateRangePicker } from '@/components/ui/date-picker'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { SortableHead } from '@/components/ui/sortable-head'
import { cn } from '@/lib/utils'
import { Download, FileSpreadsheet, GitCompareArrows, Loader2, Square } from 'lucide-react'
import { dayStats, reconcile, supplierRating, toFactRows } from './supplyPlanCalc'
import { RATING_COLUMNS, exportSupplierRatingXlsx, exportSupplyPeriodXlsx } from './supplyPeriodExport'

const msk = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10)
const shiftDay = (d, k) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10) }
const fmtD = d => (d ? d.split('-').reverse().join('.') : '')
const fmtNum = v => (v == null ? '—' : Math.round(v).toLocaleString('ru-RU'))
const fmtP = v => (v == null ? '—' : `${(v * 100).toFixed(1).replace('.', ',')}%`)
const TEXT_KEYS = new Set(['supplier'])

// «Период» графика поставок: сверка дней с WMS подряд (результат хранится на
// сервере), накопительный отчёт Excel и рейтинг поставщиков по сверенным дням.
export default function SupplyPeriodPanel() {
  const [range, setRange] = useState(() => { const y = shiftDay(msk(), -1); return { from: `${y.slice(0, 8)}01`, to: y } })
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [run, setRun] = useState(null) // { done, total, date }
  const [skipChecked, setSkipChecked] = useState(true)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState({ key: 'notArrived', dir: 'desc' })
  const stopRef = useRef(false)

  const load = async () => {
    if (!range.from || !range.to) return
    setLoading(true)
    try { setData(await api.getSupplyRange(range.from, range.to)) } catch (err) { setData(null); toast.error(err.message) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [range.from, range.to]) // eslint-disable-line react-hooks/exhaustive-deps

  const days = useMemo(() => (data ? dayStats(data, range.from, range.to) : []), [data, range])
  const checkedDays = useMemo(() => new Set((data?.facts || []).map(f => f.date)), [data])
  const planDays = useMemo(() => [...new Set((data?.plans || []).map(p => p.date))].sort(), [data])
  const rating = useMemo(() => (data ? supplierRating(data) : []), [data])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = q ? rating.filter(r => r.supplier.toLowerCase().includes(q)) : [...rating]
    return list.sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key]
      const cmp = TEXT_KEYS.has(sort.key) ? String(av).localeCompare(String(bv), 'ru') : (av ?? -1) - (bv ?? -1)
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [rating, search, sort])
  const handleSort = key => setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: TEXT_KEYS.has(key) ? 'asc' : 'desc' }))

  // сверка дней периода по очереди: график дня → задания WMS → сохранить
  const checkPeriod = async () => {
    if (!getStoredToken()) { toast.error('Нет активного WMS-токена — войдите паролем от WMS'); return }
    const today = msk()
    const todo = planDays.filter(d => d < today && !(skipChecked && checkedDays.has(d)))
    if (!todo.length) { toast.info(skipChecked ? 'Все дни периода уже сверены' : 'В периоде нет дней с графиком'); return }
    stopRef.current = false
    let ok = 0, cur = null
    try {
      for (let i = 0; i < todo.length; i++) {
        if (stopRef.current) break
        const d = (cur = todo[i])
        setRun({ done: i, total: todo.length, date: d })
        const plan = data.plans.filter(p => p.date === d)
        const tasks = await fetchInboundAroundDate(getStoredToken(), d)
        await api.saveSupplyFacts(d, toFactRows(reconcile(plan, tasks, d)))
        ok++
      }
      toast.success(`Сверено дней: ${ok}${stopRef.current ? ' (остановлено)' : ''}`)
    } catch (err) {
      toast.error(`Сверка остановлена на ${fmtD(cur)}: ${err.message}`)
    } finally {
      setRun(null)
      load()
    }
  }

  const exportReport = () => exportSupplyPeriodXlsx(data, range.from, range.to).catch(err => toast.error('Ошибка: ' + err.message))
  const total = useMemo(() => {
    const t = { plan: 0, fact: 0, factDays: 0 }
    for (const d of days) { t.plan += d.plan.count; if (d.fact) { t.fact += d.fact.count; t.factDays++ } }
    return t
  }, [days])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-card p-3 shadow-card">
        <DateRangePicker className="h-9 w-60" from={range.from} to={range.to} onChange={({ from, to }) => setRange({ from, to })} disabled={!!run} />
        {run ? (
          <>
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin text-primary" /> Сверка {run.done + 1} из {run.total} · {fmtD(run.date)}
            </div>
            <Button variant="outline" onClick={() => { stopRef.current = true }}><Square className="size-4" /> Остановить</Button>
          </>
        ) : (
          <>
            <Button variant="outline" disabled={!planDays.length} onClick={checkPeriod}><GitCompareArrows className="size-4" /> Сверить период с WMS</Button>
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <input type="checkbox" checked={skipChecked} onChange={e => setSkipChecked(e.target.checked)} /> пропускать сверенные дни
            </label>
          </>
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" disabled={!days.length || !!run} onClick={exportReport}><FileSpreadsheet className="size-4" /> Накопительный отчёт</Button>
        </div>
      </div>

      {loading && <Spinner label="Загрузка периода…" />}
      {!loading && data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Дней с графиком" value={fmtNum(planDays.length)} />
            <Tile label="Сверено с WMS" value={fmtNum(checkedDays.size)} hint={planDays.length ? `из ${planDays.length}` : ''} />
            <Tile label="Поставок по графику" value={fmtNum(total.plan)} />
            <Tile label="Принято поставок" value={total.factDays ? fmtNum(total.fact) : '—'} hint={total.factDays ? `за ${total.factDays} дн. с фактом` : 'нет факта'} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="text-base font-semibold">Рейтинг поставщиков</div>
            <span className="text-xs text-muted-foreground">по сверенным дням периода</span>
            <Input className="ml-auto h-8 max-w-xs" value={search} onChange={e => setSearch(e.target.value)} placeholder="Поставщик" />
            <Button size="sm" variant="secondary" disabled={!rating.length} onClick={() => exportSupplierRatingXlsx(rating, range.from, range.to).catch(err => toast.error(err.message))}>
              <Download className="size-4" /> Excel
            </Button>
          </div>

          {!rating.length ? (
            <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              Нет сверенных дней в периоде — нажмите «Сверить период с WMS» (или «Сверить с WMS» на вкладке «День»)
            </div>
          ) : (
            <div className="max-h-[70vh] overflow-auto rounded-2xl border border-line bg-card shadow-card">
              <Table className="[&_td+td]:border-l [&_td+td]:border-l-line [&_th+th]:border-l [&_th+th]:border-l-line">
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    {RATING_COLUMNS.map(c => (
                      <SortableHead key={c.key} label={c.header} sortKey={c.key} sort={sort} onSort={handleSort}
                        className={cn('h-10 px-2 text-[11px] leading-tight', c.numFmt && 'text-center')} />
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(r => (
                    <TableRow key={r.supplier}>
                      <TableCell className="px-3 py-1.5 text-[13px]">{r.supplier}</TableCell>
                      <Num v={r.planned} />
                      <Num v={r.accepted} />
                      <Num v={r.discrepancy} warn={r.discrepancy > 0} />
                      <Num v={r.waiting} />
                      <Num v={r.cancelled} />
                      <Num v={r.notArrived} bad={r.notArrived > 0} />
                      <Num v={r.notArrivedPct} pct bad={r.notArrivedPct >= 0.2} />
                      <Num v={r.planPieces} />
                      <Num v={r.factPieces} />
                      <Num v={r.shortfall} pct warn={r.shortfall >= 0.05} />
                      <Num v={r.extra} />
                      <Num v={r.extraPieces} />
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            «Не приехала» — заказа из графика нет в WMS. «Не принята» — задание есть, но приёмка не завершена (в т. ч. «Не проверена»). Недовоз — доля штук плана, которую не довезли по принятым заказам. «Вне графика» — принятые задания поставщика, которых не было в графике на этот день. Сверка сохраняется на сервере: повторная сверка дня заменяет прежнюю.
          </p>
        </>
      )}
    </div>
  )
}

function Tile({ label, value, hint }) {
  return (
    <div className="rounded-3xl border border-line bg-card p-4 shadow-card">
      <div className="text-[13px] font-medium text-ink-2">{label}</div>
      <div className="tabular mt-2 text-[26px] font-semibold leading-tight tracking-tight">{value}</div>
      {hint && <div className="mt-1 text-sm text-muted-foreground">{hint}</div>}
    </div>
  )
}

function Num({ v, pct, bad, warn }) {
  return (
    <TableCell className={cn('tabular px-2 py-1.5 text-center text-[13px]', bad && 'font-semibold text-destructive', !bad && warn && 'font-semibold text-warning', !v && 'text-muted-foreground')}>
      {pct ? fmtP(v) : fmtNum(v)}
    </TableCell>
  )
}
