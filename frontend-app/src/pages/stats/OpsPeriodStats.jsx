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
import { avg, kg, round1 } from './receivingExport'
import { OP_META, aggregateOps, exportMovesXlsx, groupMoves, remainsOps } from './opsExport'

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

function Kpi({ label, value }) {
  return (
    <div className="flex min-w-24 flex-col items-center rounded-md bg-muted/50 px-3.5 py-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-base font-semibold tabular-nums">{value}</span>
    </div>
  )
}

// Вкладка «За период» для спуска/пополнения/размещения/остатков (вместо
// плоского «сотрудник × день»): итоги, разрезы и полный Excel-отчёт
// (opsExport.js). Данные — /api/stats/report/{op}.
export function OpsPeriodStats({ operation, exportRef }) {
  const meta = OP_META[operation]
  const isRemains = operation === 'remains'
  const [dateFrom, setDateFrom] = useState(monthStartStr())
  const [dateTo, setDateTo] = useState(todayStr())
  const [shift, setShift] = useState('')
  const [ops, setOps] = useState(null)
  const [loaded, setLoaded] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [view, setView] = useState('executors')
  const [sort, setSort] = useState({ key: 'ops', dir: 'desc' })

  // смена операции — данные другой операции не показываем
  useEffect(() => { setOps(null); setLoaded(null); setView('executors'); setSort({ key: 'ops', dir: 'desc' }) }, [operation])

  const load = async () => {
    const to = dateTo || dateFrom
    setLoading(true)
    setError('')
    try {
      const res = await api.getOpReport(operation, dateFrom, to, shift || undefined)
      const rows = res?.rows || []
      setOps(isRemains ? remainsOps(rows) : groupMoves(rows))
      setLoaded({ from: dateFrom, to, shift })
    } catch (err) {
      setOps(null)
      setError(err.message || 'Не удалось загрузить данные за период')
    } finally {
      setLoading(false)
    }
  }

  const columns = useMemo(() => ({
    executors: [
      { key: 'company', label: 'Компания', text: true },
      { key: 'name', label: 'Сотрудник', text: true },
      { key: 'days', label: 'Дней', fmt: fmtNum },
      { key: 'ops', label: 'Операций', fmt: fmtNum },
      { key: 'positions', label: 'Позиций', fmt: fmtNum },
      { key: 'qty', label: 'Штук', fmt: fmtNum },
      ...(isRemains ? [] : [{ key: 'weight', label: 'Вес', fmt: fmtKg }]),
      { key: 'perDay', label: 'Операций / день', fmt: fmtNum },
      { key: 'perHour', label: 'Операций / час', fmt: fmtNum },
      ...(isRemains ? [] : [{ key: 'avgDuration', label: 'Ср. длит., мин', fmt: fmtNum }]),
    ],
    days: [
      { key: 'date', label: 'Дата смены', text: true, fmt: fmtDate },
      { key: 'ops', label: 'Операций', fmt: fmtNum },
      { key: 'positions', label: 'Позиций', fmt: fmtNum },
      { key: 'qty', label: 'Штук', fmt: fmtNum },
      ...(isRemains ? [] : [{ key: 'weight', label: 'Вес', fmt: fmtKg }]),
      { key: 'executors', label: 'Сотрудников', fmt: fmtNum },
      { key: 'perExecutor', label: 'Операций на сотрудника', fmt: fmtNum },
    ],
    companies: [
      { key: 'company', label: 'Компания', text: true },
      { key: 'executors', label: 'Сотрудников', fmt: fmtNum },
      { key: 'ops', label: 'Операций', fmt: fmtNum },
      { key: 'share', label: 'Доля', fmt: v => `${(v * 100).toFixed(1)}%` },
      { key: 'qty', label: 'Штук', fmt: fmtNum },
      ...(isRemains ? [] : [{ key: 'weight', label: 'Вес', fmt: fmtKg }]),
      { key: 'perExecutor', label: 'Операций на сотрудника', fmt: fmtNum },
    ],
    cells: [
      { key: 'cell', label: meta.keyCellLabel, text: true },
      { key: 'ops', label: 'Операций', fmt: fmtNum },
      { key: 'maxPerDay', label: 'Макс. за день', fmt: fmtNum },
      { key: 'avgPerDay', label: 'В среднем за день', fmt: fmtNum },
      { key: 'qty', label: 'Штук', fmt: fmtNum },
      { key: 'executors', label: 'Сотрудников', fmt: fmtNum },
    ],
  }), [isRemains, meta.keyCellLabel])
  const views = [
    { key: 'executors', label: 'Сотрудники' },
    { key: 'days', label: 'По дням' },
    { key: 'companies', label: 'Компании' },
    { key: 'cells', label: 'Ячейки' },
  ]

  const stats = useMemo(() => {
    if (!ops) return null
    const T = aggregateOps(ops, () => 'all')[0]
    const dayCount = new Set(ops.map(o => o.shiftDate)).size
    const executors = aggregateOps(ops, o => o.executorId || o.executor || '—').map(a => ({
      company: a.sample.company || '—', name: a.sample.executor || '—', days: a.days.size,
      ops: a.ops, positions: a.positions, qty: a.qty, weight: kg(a.grams),
      perDay: round1(share(a.ops, a.days.size)), perHour: round1(share(a.ops, a.hours.size)), avgDuration: round1(avg(a.durations)),
    }))
    const days = aggregateOps(ops, o => o.shiftDate).map(a => ({
      date: a.key, ops: a.ops, positions: a.positions, qty: a.qty, weight: kg(a.grams),
      executors: a.executors.size, perExecutor: round1(share(a.ops, a.executors.size)),
    }))
    const companies = aggregateOps(ops, o => o.company || '—').map(a => ({
      company: a.key, executors: a.executors.size, ops: a.ops, share: share(a.ops, T?.ops || 0),
      qty: a.qty, weight: kg(a.grams), perExecutor: round1(share(a.ops, a.executors.size)),
    }))
    const cells = aggregateOps(ops, o => o[meta.keyCell] || '—').map(a => ({
      cell: a.key, ops: a.ops, qty: a.qty, executors: a.executors.size,
      maxPerDay: Math.max(0, ...a.perDay.values()), avgPerDay: round1(share(a.ops, a.days.size)),
    })).sort((a, b) => b.ops - a.ops).slice(0, 500)
    return { T, dayCount, executors, days, companies, cells }
  }, [ops, meta.keyCell])

  const handleSort = key => setSort(s => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: columns[view].find(c => c.key === key)?.text ? 'asc' : 'desc' }))
  const switchView = v => { setView(v); setSort(v === 'days' ? { key: 'date', dir: 'asc' } : { key: 'ops', dir: 'desc' }) }

  const sorted = useMemo(() => {
    const list = stats?.[view] ? [...stats[view]] : []
    const col = columns[view].find(c => c.key === sort.key)
    list.sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key]
      const cmp = col?.text ? String(av ?? '').localeCompare(String(bv ?? ''), 'ru') : (Number(av) || 0) - (Number(bv) || 0)
      return sort.dir === 'asc' ? cmp : -cmp
    })
    return list
  }, [stats, view, sort, columns])

  const handleExport = async () => {
    if (!ops?.length || !loaded) { toast.info('Сначала загрузите период'); return }
    const shiftLbl = loaded.shift === 'day' ? 'дневные смены' : loaded.shift === 'night' ? 'ночные смены' : 'все смены'
    await exportMovesXlsx(operation, ops, {
      periodLabel: `${fmtDate(loaded.from)} — ${fmtDate(loaded.to)} · ${shiftLbl}`,
      fileName: `${meta.file}_${loaded.from}_${loaded.to}${loaded.shift ? '_' + loaded.shift : ''}.xlsx`,
    })
  }
  useEffect(() => { if (exportRef) exportRef.current = handleExport })

  const T = stats?.T

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
        {loaded && <span className="text-xs text-muted-foreground">{fmtDate(loaded.from)} — {fmtDate(loaded.to)} · операций: {ops?.length ?? 0}</span>}
      </div>

      {loading && <Spinner label="Загрузка за период..." />}
      {!loading && ops === null && <div className="p-6 text-center text-sm text-muted-foreground">Выберите период и нажмите «Загрузить»</div>}
      {!loading && ops !== null && ops.length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">Нет операций за выбранный период</div>}

      {!loading && T && (
        <>
          <div className="flex flex-wrap gap-2">
            <Kpi label="Операций (ЕО)" value={fmtNum(T.ops)} />
            <Kpi label="Позиций" value={fmtNum(T.positions)} />
            <Kpi label="Штук" value={fmtNum(T.qty)} />
            {!isRemains && <Kpi label="Вес" value={fmtKg(kg(T.grams))} />}
            <Kpi label="Сотрудников" value={fmtNum(T.executors.size)} />
            <Kpi label="Дней" value={fmtNum(stats.dayCount)} />
            <Kpi label="Операций в день" value={fmtNum(round1(share(T.ops, stats.dayCount)))} />
            <Kpi label="На сотрудника" value={fmtNum(round1(share(T.ops, T.executors.size)))} />
            {!isRemains && <Kpi label="Ср. длит., мин" value={fmtNum(round1(avg(T.durations)))} />}
          </div>

          <div className="flex w-fit gap-1 rounded-md border bg-muted/30 p-0.5">
            {views.map(v => (
              <Button key={v.key} size="sm" className="h-[26px] px-3 text-xs" variant={view === v.key ? 'default' : 'ghost'} onClick={() => switchView(v.key)}>{v.label}</Button>
            ))}
          </div>

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  {columns[view].map(c => <SortableHead key={c.key} label={c.label} sortKey={c.key} sort={sort} onSort={handleSort} className={`${thCls}${c.text || c.date ? "" : " text-center"}`} />)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((r, i) => (
                  <TableRow key={r.date || r.cell || r.name || r.company || i}>
                    {columns[view].map(c => (
                      <TableCell key={c.key} className={`${tdCls} ${c.text ? '' : 'text-center tabular-nums'} ${c.key === 'name' || c.key === 'date' || c.key === 'cell' ? 'font-medium' : ''}`}>
                        {c.fmt ? c.fmt(r[c.key]) : (r[c.key] ?? '—')}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            Операция — одна ЕО у сотрудника за одно завершение. Ночная смена относится к дате её начала (21:00).
            {!isRemains && ' Вес — по справочнику весов товаров.'} {view === 'cells' && 'Ячейки — топ-500 по числу операций.'} XLSX — полный отчёт за период.
          </p>
        </>
      )}
    </div>
  )
}
