import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { DateRangePicker } from '@/components/ui/date-picker'
import { Select } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableHeader, TableBody, TableRow, TableCell } from '@/components/ui/table'
import { SortableHead } from '@/components/ui/sortable-head'
import { RefreshCw } from 'lucide-react'
import { aggregate, avg, exportReceivingXlsx, kg, round1 } from './receivingExport'

const selectClass = 'h-8 rounded-md border border-input bg-transparent px-2 text-sm'
const thCls = 'h-8 px-2 text-[11px]'
const tdCls = 'px-2 py-1.5 text-[13px] whitespace-nowrap'

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function monthStartStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}
const fmtDate = d => (d ? d.split('-').reverse().join('.') : '—')
const fmtNum = v => (v == null ? '—' : Number(v).toLocaleString('ru-RU'))
const fmtKg = v => (v == null ? '—' : `${Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} кг`)
const share = (part, whole) => (whole ? part / whole : 0)

const VIEWS = [
  { key: 'executors', label: 'Приёмщики' },
  { key: 'days', label: 'По дням' },
  { key: 'companies', label: 'Компании' },
]

// Колонки таблиц: key — поле строки, fmt — отображение, sortable — по умолчанию да.
const COLUMNS = {
  executors: [
    { key: 'company', label: 'Компания', text: true },
    { key: 'name', label: 'Приёмщик', text: true },
    { key: 'days', label: 'Дней', fmt: fmtNum },
    { key: 'deliveries', label: 'Поставок', fmt: fmtNum },
    { key: 'eo', label: 'ЕО', fmt: fmtNum },
    { key: 'sku', label: 'SKU', fmt: fmtNum },
    { key: 'pieces', label: 'Штук', fmt: fmtNum },
    { key: 'weight', label: 'Вес', fmt: fmtKg },
    { key: 'perDay', label: 'Поставок / день', fmt: fmtNum },
    { key: 'kgPerDay', label: 'кг / день', fmt: fmtKg },
    { key: 'avgDuration', label: 'Ср. приёмка, мин', fmt: fmtNum },
    { key: 'discrepancy', label: 'С расхожд.', fmt: fmtNum },
  ],
  days: [
    { key: 'date', label: 'Дата смены', text: true, fmt: fmtDate },
    { key: 'deliveries', label: 'Поставок', fmt: fmtNum },
    { key: 'eo', label: 'ЕО', fmt: fmtNum },
    { key: 'sku', label: 'SKU', fmt: fmtNum },
    { key: 'pieces', label: 'Штук', fmt: fmtNum },
    { key: 'weight', label: 'Вес', fmt: fmtKg },
    { key: 'executors', label: 'Приёмщиков', fmt: fmtNum },
    { key: 'perExecutor', label: 'Поставок на приёмщика', fmt: fmtNum },
    { key: 'avgDuration', label: 'Ср. приёмка, мин', fmt: fmtNum },
    { key: 'discrepancy', label: 'С расхожд.', fmt: fmtNum },
  ],
  companies: [
    { key: 'company', label: 'Компания', text: true },
    { key: 'executors', label: 'Приёмщиков', fmt: fmtNum },
    { key: 'deliveries', label: 'Поставок', fmt: fmtNum },
    { key: 'share', label: 'Доля', fmt: v => `${(v * 100).toFixed(1)}%` },
    { key: 'eo', label: 'ЕО', fmt: fmtNum },
    { key: 'pieces', label: 'Штук', fmt: fmtNum },
    { key: 'weight', label: 'Вес', fmt: fmtKg },
    { key: 'perExecutor', label: 'Поставок на приёмщика', fmt: fmtNum },
  ],
}

function Kpi({ label, value }) {
  return (
    <div className="flex min-w-24 flex-col items-center rounded-md bg-muted/50 px-3.5 py-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-base font-semibold tabular-nums">{value}</span>
    </div>
  )
}

// Вкладка «За период» для приёмки (вместо плоского списка «сотрудник × день»):
// итоги периода, разрезы по приёмщикам/дням/компаниям и тот же многолистовой
// Excel-отчёт, что у смены (receivingExport.js) — плюс лист «По дням».
export function ReceivingPeriodStats({ exportRef }) {
  const [dateFrom, setDateFrom] = useState(monthStartStr())
  const [dateTo, setDateTo] = useState(todayStr())
  const [shift, setShift] = useState('')
  const [rows, setRows] = useState(null)
  const [loaded, setLoaded] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [view, setView] = useState('executors')
  const [sort, setSort] = useState({ key: 'deliveries', dir: 'desc' })

  const load = async () => {
    const to = dateTo || dateFrom
    setLoading(true)
    setError('')
    try {
      const res = await api.getReceivingPeriodRows(dateFrom, to, shift || undefined)
      setRows(res?.rows || [])
      setLoaded({ from: dateFrom, to, shift })
    } catch (err) {
      setRows(null)
      setError(err.message || 'Не удалось загрузить приёмку за период')
    } finally {
      setLoading(false)
    }
  }

  const stats = useMemo(() => {
    if (!rows) return null
    const totals = aggregate(rows, () => 'all')[0]
    const dayCount = new Set(rows.map(r => r.shiftDate)).size
    const executors = aggregate(rows, r => r.executorId || r.executor || '—').map(a => ({
      company: a.sample.company || '—', name: a.sample.executor || '—', days: a.days.size,
      deliveries: a.deliveries, eo: a.eo, sku: a.sku, pieces: a.pieces, weight: kg(a.grams),
      perDay: round1(share(a.deliveries, a.days.size)), kgPerDay: kg(share(a.grams, a.days.size)),
      avgDuration: round1(avg(a.durations)), discrepancy: a.discrepancy,
    }))
    const days = aggregate(rows, r => r.shiftDate).map(a => ({
      date: a.key, deliveries: a.deliveries, eo: a.eo, sku: a.sku, pieces: a.pieces, weight: kg(a.grams),
      executors: a.executors.size, perExecutor: round1(share(a.deliveries, a.executors.size)),
      avgDuration: round1(avg(a.durations)), discrepancy: a.discrepancy,
    }))
    const companies = aggregate(rows, r => r.company || '—').map(a => ({
      company: a.key, executors: a.executors.size, deliveries: a.deliveries, share: share(a.deliveries, totals?.deliveries || 0),
      eo: a.eo, pieces: a.pieces, weight: kg(a.grams), perExecutor: round1(share(a.deliveries, a.executors.size)),
    }))
    return { totals, dayCount, executors, days, companies }
  }, [rows])

  const handleSort = key => setSort(s => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: COLUMNS[view].find(c => c.key === key)?.text ? 'asc' : 'desc' }))
  const switchView = v => { setView(v); setSort(v === 'days' ? { key: 'date', dir: 'asc' } : { key: 'deliveries', dir: 'desc' }) }

  const sorted = useMemo(() => {
    const list = stats?.[view] ? [...stats[view]] : []
    const col = COLUMNS[view].find(c => c.key === sort.key)
    list.sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key]
      const cmp = col?.text ? String(av ?? '').localeCompare(String(bv ?? ''), 'ru') : (Number(av) || 0) - (Number(bv) || 0)
      return sort.dir === 'asc' ? cmp : -cmp
    })
    return list
  }, [stats, view, sort])

  const handleExport = async () => {
    if (!rows?.length || !loaded) { toast.info('Сначала загрузите период'); return }
    const shiftLbl = loaded.shift === 'day' ? 'дневные смены' : loaded.shift === 'night' ? 'ночные смены' : 'все смены'
    await exportReceivingXlsx(rows, {
      periodLabel: `${fmtDate(loaded.from)} — ${fmtDate(loaded.to)} · ${shiftLbl}`,
      fileName: `приемка_${loaded.from}_${loaded.to}${loaded.shift ? '_' + loaded.shift : ''}.xlsx`,
    })
  }
  useEffect(() => { if (exportRef) exportRef.current = handleExport })

  const t = stats?.totals

  return (
    <div className="space-y-3">
      {error && <div className="text-sm text-destructive">{error}</div>}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Период:</span>
        <DateRangePicker className="h-8" from={dateFrom} to={dateTo} onChange={({ from, to }) => { setDateFrom(from); setDateTo(to) }} />
        <Select className={selectClass} value={shift} onChange={e => setShift(e.target.value)}>
          <option value="">Все смены</option>
          <option value="day">День (9–21)</option>
          <option value="night">Ночь (21–9)</option>
        </Select>
        <Button size="sm" variant="secondary" onClick={load} disabled={loading || !dateFrom}>
          <RefreshCw className="size-3.5" /> {loading ? 'Загрузка...' : 'Загрузить'}
        </Button>
        {loaded && <span className="text-xs text-muted-foreground">{fmtDate(loaded.from)} — {fmtDate(loaded.to)} · поставок: {rows?.length ?? 0}</span>}
      </div>

      {loading && <Spinner label="Загрузка приёмки за период..." />}
      {!loading && rows === null && <div className="p-6 text-center text-sm text-muted-foreground">Выберите период и нажмите «Загрузить»</div>}
      {!loading && rows !== null && rows.length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">Нет принятых поставок за выбранный период</div>}

      {!loading && t && (
        <>
          <div className="flex flex-wrap gap-2">
            <Kpi label="Поставок" value={fmtNum(t.deliveries)} />
            <Kpi label="ЕО" value={fmtNum(t.eo)} />
            <Kpi label="SKU" value={fmtNum(t.sku)} />
            <Kpi label="Штук" value={fmtNum(t.pieces)} />
            <Kpi label="Вес" value={fmtKg(kg(t.grams))} />
            <Kpi label="Приёмщиков" value={fmtNum(t.executors.size)} />
            <Kpi label="Дней" value={fmtNum(stats.dayCount)} />
            <Kpi label="Поставок в день" value={fmtNum(round1(share(t.deliveries, stats.dayCount)))} />
            <Kpi label="Ср. приёмка, мин" value={fmtNum(round1(avg(t.durations)))} />
            <Kpi label="С расхождением" value={`${fmtNum(t.discrepancy)} (${(share(t.discrepancy, t.deliveries) * 100).toFixed(1)}%)`} />
          </div>

          <div className="flex gap-1 rounded-md border bg-muted/30 p-0.5 w-fit">
            {VIEWS.map(v => (
              <Button key={v.key} size="sm" className="h-[26px] px-3 text-xs" variant={view === v.key ? 'default' : 'ghost'} onClick={() => switchView(v.key)}>{v.label}</Button>
            ))}
          </div>

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  {COLUMNS[view].map(c => <SortableHead key={c.key} label={c.label} sortKey={c.key} sort={sort} onSort={handleSort} className={thCls} />)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((r, i) => (
                  <TableRow key={r.date || r.name || r.company || i}>
                    {COLUMNS[view].map(c => (
                      <TableCell key={c.key} className={`${tdCls} ${c.text ? '' : 'text-right tabular-nums'} ${c.key === 'name' || c.key === 'date' ? 'font-medium' : ''}`}>
                        {c.fmt ? c.fmt(r[c.key]) : (r[c.key] ?? '—')}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            Дата смены: ночная смена относится к дате её начала (21:00). SKU — плановое, штуки и вес — фактические. XLSX — полный отчёт по периоду (сводка, приёмщики, компании, дни, часы, поставщики, поставки).
          </p>
        </>
      )}
    </div>
  )
}
