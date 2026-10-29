import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { getStoredToken, fetchInboundAroundDate } from '@/lib/wmsFetch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DatePicker } from '@/components/ui/date-picker'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { SortableHead } from '@/components/ui/sortable-head'
import { cn } from '@/lib/utils'
import { Copy, Download, GitCompareArrows, Image, Loader2, Upload, TrendingUp } from 'lucide-react'
import { SUPPLY_GROUPS, fmtK, forecastKdk, fromFactRows, groupOf, kdkPlanOf, pct, reconcile, storageKeys, summarize, summarizeFact, toFactRows } from './supplyPlanCalc'
import SupplyPeriodPanel from './SupplyPeriodPanel'
import { exportSupplyPlanXlsx } from './supplyPlanExport'
import { SUPPLY_IMAGES, copySupplyPlanPng, downloadSupplyPlanPng } from './supplyPlanImage'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { STATUS_LABELS as WMS_STATUS_LABELS } from '@/pages/supplies/constants'

const WEEKDAYS = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ']
const weekday = d => WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]
// «на среду, 28.10.2026» — винительный падеж
const WEEKDAY_ACC = ['воскресенье', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу']
// заголовки картинок — «Среда, 28.10.2026»
const WEEKDAY_FULL = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота']
const fmtDate = d => (d ? d.split('-').reverse().join('.') : '')
const fmtNum = v => (v == null ? '—' : Math.round(v).toLocaleString('ru-RU'))
const fmtPct = p => (p == null ? '' : `${p > 0 ? '+' : ''}${(p * 100).toFixed(0)}%`)
const pctCls = p => (p == null ? 'text-muted-foreground' : Math.abs(p) < 0.03 ? 'text-muted-foreground' : p < 0 ? 'text-destructive' : 'text-success')
const fmtTime = iso => (iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')
const tomorrow = () => new Date(Date.now() + 3 * 3600000 + 86400000).toISOString().slice(0, 10)

const STATUS = {
  accepted: { label: 'Принята', cls: 'bg-success/12 text-success' },
  discrepancy: { label: 'С расхождением', cls: 'bg-warning/15 text-warning' },
  notVerified: { label: 'Не проверена', cls: 'bg-info/12 text-info' },
  inProgress: { label: 'Не принята', cls: 'bg-info/12 text-info' },
  cancelled: { label: 'Отменена', cls: 'bg-muted text-muted-foreground' },
  missing: { label: 'Нет в WMS', cls: 'bg-destructive/10 text-destructive' },
  extra: { label: 'Вне графика', cls: 'bg-muted text-foreground' },
}
// вертикальные разделители таблиц: G — между группами показателей, I — тонкая внутри группы
const G = 'border-l-2! border-l-foreground/25!'
const I = 'border-l border-l-line'

const METRICS = [
  { key: 'count', label: 'Поставок' },
  { key: 'pieces', label: 'Штук' },
  { key: 'weightKg', label: 'Вес, кг' },
  { key: 'sku', label: 'SKU' },
]

function Kpi({ label, plan, fact }) {
  const p = fact != null ? pct(fact, plan) : null
  return (
    <div className="rounded-3xl border border-line bg-card p-4 shadow-card">
      <div className="text-[13px] font-medium text-ink-2">{label}</div>
      <div className="tabular mt-2 text-[26px] font-semibold leading-tight tracking-tight">{fmtNum(plan)}</div>
      {fact != null
        ? <div className="mt-1 text-sm">факт <b className="tabular">{fmtNum(fact)}</b> <span className={cn('font-semibold', pctCls(p))}>{fmtPct(p)}</span></div>
        : <div className="mt-1 text-sm text-muted-foreground">план</div>}
    </div>
  )
}

// «График поставок»: план приёмки на дату из Excel корп. почты (или
// накопительного отчёта), разбивка КДК/хранение × тип хранения, сверка с
// WMS по номеру заказа, прогноз СЗ КДК по истории и выгрузка в Excel.
export default function SupplyPlanPage() {
  const [tab, setTab] = useState('day')
  return (
    <div className="mx-auto w-full space-y-4 p-6">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">График поставок</h1>
          <p className="text-sm text-muted-foreground">План приёмки из графика поставок, сверка с WMS по номеру заказа, прогноз СЗ КДК, накопительный отчёт и рейтинг поставщиков</p>
        </div>
        <div className="ml-auto flex rounded-full border border-line bg-card p-0.5">
          {[['day', 'День'], ['period', 'Период']].map(([k, label]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={cn('rounded-full px-4 py-1.5 text-sm', tab === k ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}>{label}</button>
          ))}
        </div>
      </div>
      {tab === 'day' ? <SupplyDay /> : <SupplyPeriodPanel />}
    </div>
  )
}

function SupplyDay() {
  const [date, setDate] = useState(tomorrow())
  const [dates, setDates] = useState(null)
  const [plan, setPlan] = useState(null)
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [recon, setRecon] = useState(null) // { rows, extra, at }
  const [history, setHistory] = useState(null) // null — грузится, { error } — не загрузилась
  const loadHistory = () => api.getKdkHistory(180).then(setHistory).catch(err => setHistory({ error: err.message || 'ошибка сервера' }))
  const [groupFilter, setGroupFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState({ key: 'supplier', dir: 'asc' })
  const fileRef = useRef(null)

  const loadDates = () => api.getSupplyPlanDates().then(setDates).catch(() => {})
  useEffect(() => {
    loadDates()
    loadHistory()
  }, [])
  useEffect(() => {
    setRecon(null)
    setLoading(true)
    let alive = true
    Promise.all([api.getSupplyPlan(date), api.getSupplyRange(date, date).catch(() => null)])
      .then(([r, range]) => {
        if (!alive) return
        const rows = r.rows || []
        setPlan(rows)
        // день уже сверяли — показываем сохранённую сверку без запроса в WMS
        setRecon(fromFactRows(rows, range?.facts))
      })
      .catch(err => { if (alive) { setPlan([]); toast.error(err.message) } })
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [date])

  const handleUpload = async e => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    try {
      const res = await api.uploadSupplyPlans(file)
      toast.success(`График загружен: ${res.dates} дн. (${fmtDate(res.from)} — ${fmtDate(res.to)}), заказов ${res.rows.toLocaleString('ru-RU')}${res.dayFacts ? `, итогов факта из «статистики»: ${res.dayFacts}` : ''}`)
      await loadDates()
      const r = await api.getSupplyPlan(date)
      setPlan(r.rows || [])
      loadHistory()
    } catch (err) {
      toast.error('Ошибка загрузки: ' + err.message)
    } finally {
      setUploading(false)
    }
  }

  const handleCheck = async () => {
    const token = getStoredToken()
    if (!token) { toast.error('Нет активного WMS-токена — войдите паролем от WMS'); return }
    setChecking(true)
    try {
      const tasks = await fetchInboundAroundDate(token, date)
      const res = reconcile(plan, tasks, date)
      setRecon({ ...res, at: new Date() })
      // сохраняем — для накопительного отчёта и рейтинга поставщиков
      api.saveSupplyFacts(date, toFactRows(res)).catch(err => toast.error('Сверка не сохранилась: ' + err.message))
    } catch (err) {
      toast.error('Не удалось сверить с WMS: ' + err.message)
    } finally {
      setChecking(false)
    }
  }

  const planSum = useMemo(() => summarize(plan || []), [plan])
  const factSum = useMemo(() => (recon ? summarizeFact(recon.rows, recon.extra) : null), [recon])
  // пока история не загрузилась — прогноза нет (а не «мало истории»)
  const forecast = useMemo(() => (plan?.length && history?.plans ? forecastKdk(history, date, kdkPlanOf(plan)) : null), [history, date, plan])

  const statusCounts = useMemo(() => {
    if (!recon) return null
    const c = { accepted: 0, discrepancy: 0, notVerified: 0, inProgress: 0, cancelled: 0, missing: 0, extra: recon.extra.length }
    for (const r of recon.rows) c[r.status]++
    return c
  }, [recon])

  const tableRows = useMemo(() => {
    let rows = recon ? [...recon.rows, ...recon.extra] : (plan || []).map(r => ({ ...r, status: null }))
    // у заданий вне графика тип в кодах WMS: CROSSDOCK — кросс-док, остальное — хранение
    if (groupFilter !== 'all') rows = rows.filter(r => groupOf(r.status === 'extra' ? (r.supplyType === 'CROSSDOCK' ? 'Кросс-докинг' : 'Хранение') : r.supplyType) === groupFilter)
    if (statusFilter !== 'all') rows = rows.filter(r => r.status === statusFilter)
    const q = search.trim().toLowerCase()
    if (q) rows = rows.filter(r => (r.supplier || '').toLowerCase().includes(q) || (r.orderNumber || '').toLowerCase().includes(q))
    const val = (r, k) => (k.startsWith('fact.') ? r.fact?.[k.slice(5)] ?? -1 : r[k])
    const text = ['supplier', 'orderNumber', 'supplyType', 'storageType', 'status'].includes(sort.key)
    return rows.sort((a, b) => {
      const av = val(a, sort.key), bv = val(b, sort.key)
      const cmp = text ? String(av ?? '').localeCompare(String(bv ?? ''), 'ru') : (Number(av) || 0) - (Number(bv) || 0)
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [plan, recon, groupFilter, statusFilter, search, sort])

  const handleSort = key => setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  const upcoming = (dates?.dates || []).filter(d => d.date >= new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10)).slice(0, 8)

  const exportXlsx = () => exportSupplyPlanXlsx({ date, weekday: weekday(date), plan, planSum, recon, factSum, forecast })
  // картинка итогов — переслать в мессенджер (supplyPlanImage.js)
  // картинки для рассылки (supplyPlanImage.js): общие цифры и списки поставок по хранению / КДК
  const imageOpts = () => ({
    date, weekday: WEEKDAY_FULL[new Date(`${date}T00:00:00Z`).getUTCDay()], planSum, factSum, forecast, statusCounts,
    statusLabels: Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, v.label])),
    orders: (recon ? recon.rows : plan).map(r => ({ ...r, group: groupOf(r.supplyType) })),
  })
  const savePng = kind => downloadSupplyPlanPng(kind, imageOpts()).catch(err => toast.error('Ошибка: ' + err.message))
  const copyPng = kind => copySupplyPlanPng(kind, imageOpts()).then(() => toast.success('Картинка скопирована — вставьте в чат (Ctrl+V)')).catch(err => toast.error(err.message))
  const saveAllPng = async () => { for (const i of SUPPLY_IMAGES) await savePng(i.key) }

  const breakdownRows = []
  for (const g of SUPPLY_GROUPS) {
    const pg = planSum.groups[g.key]
    if (!pg) continue
    const fg = factSum?.groups[g.key]
    breakdownRows.push({ key: g.key, label: g.label, plan: pg.totals, fact: fg?.totals || (factSum ? { count: 0, pieces: 0, weightKg: 0, sku: 0 } : null), strong: true })
    const keys = storageKeys({ ...pg.byStorage, ...(fg?.byStorage || {}) })
    for (const st of keys) breakdownRows.push({ key: `${g.key}-${st}`, label: st, plan: pg.byStorage[st] || { count: 0, pieces: 0, weightKg: 0, sku: 0 }, fact: factSum ? (fg?.byStorage[st] || { count: 0, pieces: 0, weightKg: 0, sku: 0 }) : null })
  }

  return (
    <div className="space-y-4">

      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-card p-3 shadow-card">
        <DatePicker className="h-9 w-44" value={date} onChange={e => setDate(e.target.value)} />
        {upcoming.map(d => (
          <button key={d.date} type="button" onClick={() => setDate(d.date)}
            className={cn('rounded-full border px-3 py-1 text-xs', d.date === date ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted')}>
            {weekday(d.date)} {fmtDate(d.date).slice(0, 5)} · {d.orders}
          </button>
        ))}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" disabled={uploading} onClick={() => fileRef.current?.click()}>
            <Upload className="size-4" /> {uploading ? 'Загрузка…' : 'Загрузить график'}
          </Button>
          <input ref={fileRef} type="file" accept=".xls,.xlsx" className="hidden" onChange={handleUpload} />
          <Button variant="outline" disabled={checking || !plan?.length} onClick={handleCheck}>
            <GitCompareArrows className="size-4" /> {checking ? 'Сверка…' : recon ? 'Сверить заново' : 'Сверить с WMS'}
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="secondary" disabled={!plan?.length}><Image className="size-4" /> Картинки</Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-2">
              {SUPPLY_IMAGES.map(i => (
                <div key={i.key} className="flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-muted">
                  <span className="flex-1 text-sm">{i.label}</span>
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => savePng(i.key)} title="Скачать PNG"><Download className="size-3.5" /></Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => copyPng(i.key)} title="Скопировать — вставить в чат"><Copy className="size-3.5" /></Button>
                </div>
              ))}
              <Button size="sm" className="mt-1 w-full" onClick={saveAllPng}><Download className="size-3.5" /> Скачать все три</Button>
            </PopoverContent>
          </Popover>
          <Button variant="secondary" disabled={!plan?.length} onClick={exportXlsx}><Download className="size-4" /> Excel</Button>
        </div>
      </div>
      {dates && (
        <div className="-mt-2 text-xs text-muted-foreground">
          {dates.totalDays ? `В базе графиков: ${dates.totalDays} дн. с ${fmtDate(String(dates.firstDate).slice(0, 10))}` : 'Графиков пока нет — загрузите файл из почты (можно и накопительный отчёт целиком)'}
          {recon?.at && ` · сверено с WMS ${recon.saved ? recon.at.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'в ' + recon.at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`}
        </div>
      )}

      {loading && <Spinner label="Загрузка графика…" />}
      {!loading && plan && !plan.length && (
        <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">На {weekday(date)} {fmtDate(date)} графика нет — загрузите свежий файл из почты</div>
      )}

      {!loading && plan?.length > 0 && (
        <>
          <div className="text-lg font-semibold">{weekday(date)}, {fmtDate(date)}</div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {METRICS.map(m => <Kpi key={m.key} label={m.label} plan={planSum.total[m.key]} fact={factSum ? factSum.total[m.key] : null} />)}
          </div>

          <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
            <div className="overflow-x-auto rounded-2xl border border-line bg-card shadow-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-9 px-3 text-[11px]">Тип поставки / хранения</TableHead>
                    {METRICS.map(m => (
                      <TableHead key={m.key} colSpan={factSum ? 3 : 1} className={cn('h-9 px-3 text-center text-[11px]', G)}>{m.label}</TableHead>
                    ))}
                  </TableRow>
                  {factSum && (
                    <TableRow>
                      <TableHead className="h-7 px-3" />
                      {METRICS.map(m => ['план', 'факт', '%'].map((h, i) => (
                        <TableHead key={m.key + h} className={cn('h-7 px-2 text-center text-[10px] font-normal', i === 0 ? G : I)}>{h}</TableHead>
                      )))}
                    </TableRow>
                  )}
                </TableHeader>
                <TableBody>
                  {breakdownRows.map(r => (
                    <TableRow key={r.key} className={cn(r.strong && 'bg-muted/40 font-semibold')}>
                      <TableCell className={cn('px-3 py-1.5 text-[13px]', !r.strong && 'pl-7 text-muted-foreground')}>{r.label}</TableCell>
                      {METRICS.map(m => (
                        factSum ? [
                          <TableCell key={m.key + 'p'} className={cn('tabular px-2 py-1.5 text-center text-[13px]', G)}>{fmtNum(r.plan[m.key])}</TableCell>,
                          <TableCell key={m.key + 'f'} className={cn('tabular px-2 py-1.5 text-center text-[13px]', I)}>{fmtNum(r.fact[m.key])}</TableCell>,
                          <TableCell key={m.key + '%'} className={cn('tabular px-2 py-1.5 text-center text-[12px]', I, pctCls(pct(r.fact[m.key], r.plan[m.key])))}>{fmtPct(pct(r.fact[m.key], r.plan[m.key]))}</TableCell>,
                        ] : <TableCell key={m.key} className={cn('tabular px-3 py-1.5 text-center text-[13px]', G)}>{fmtNum(r.plan[m.key])}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="rounded-2xl border border-line bg-card p-4 shadow-card">
              <div className="flex items-center gap-2 text-sm font-semibold"><TrendingUp className="size-4 text-primary" /> Прогноз СЗ КДК</div>
              {forecast?.ok ? (
                <>
                  <div className="tabular mt-2 text-[32px] font-semibold leading-tight">~{fmtNum(forecast.value)}</div>
                  <div className="text-sm text-muted-foreground">на {WEEKDAY_ACC[new Date(`${forecast.shiftDate}T00:00:00Z`).getUTCDay()]}, {fmtDate(forecast.shiftDate)}</div>
                  <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                    <div>{fmtNum(forecast.x)} {forecast.metric.label} × {fmtK(forecast.k)} СЗ {forecast.metric.per}</div>
                    <div>по {forecast.days} дням истории · типичная погрешность ±{Math.round(forecast.err * 100)}%</div>
                  </div>
                </>
              ) : !history ? (
                <div className="mt-3 space-y-2">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin text-primary" /> Считаем прогноз по истории…</div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full w-1/3 animate-pulse rounded-full bg-primary/60" /></div>
                </div>
              ) : history.error ? (
                <div className="mt-2 space-y-2 text-sm">
                  <div className="text-destructive">Не удалось загрузить историю: {history.error}</div>
                  <Button size="sm" variant="outline" onClick={() => { setHistory(null); loadHistory() }}>Повторить</Button>
                </div>
              ) : (
                <div className="mt-2 space-y-1 text-sm text-muted-foreground">
                  <div>Прогноз пока не строится: для расчёта нужно не меньше 7 прошедших дней, где есть и план кросс-дока, и раскладка КДК.</div>
                  <div className="text-xs">За 180 дней: план КДК — {forecast?.planDays ?? 0} дн., раскладка КДК — {forecast?.pickDays ?? 0} дн., совпало — {forecast?.matched ?? 0} дн.</div>
                </div>
              )}
            </div>
          </div>

          {statusCounts && (
            <div className="flex flex-wrap gap-2">
              {[['all', 'Все', recon.rows.length + recon.extra.length], ...Object.entries(statusCounts).filter(([k, v]) => v > 0 || ['accepted', 'inProgress', 'missing'].includes(k)).map(([k, v]) => [k, STATUS[k].label, v])].map(([k, label, v]) => (
                <button key={k} type="button" onClick={() => setStatusFilter(k)}
                  className={cn('rounded-full border px-3 py-1 text-xs', statusFilter === k ? 'border-primary ring-2 ring-primary/30' : '', k !== 'all' && STATUS[k].cls)}>
                  {label}: <b>{v}</b>
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {[['all', 'Все'], ...SUPPLY_GROUPS.map(g => [g.key, g.label])].map(([k, label]) => (
              <Button key={k} size="sm" variant={groupFilter === k ? 'default' : 'ghost'} className="h-8" onClick={() => setGroupFilter(k)}>{label}</Button>
            ))}
            <Input className="ml-auto h-8 max-w-xs" value={search} onChange={e => setSearch(e.target.value)} placeholder="Поставщик или номер заказа" />
          </div>

          <div className="overflow-x-auto rounded-2xl border border-line bg-card shadow-card">
            <Table className="[&_td+td]:border-l [&_td+td]:border-l-line [&_th+th]:border-l [&_th+th]:border-l-line">
              <TableHeader>
                <TableRow>
                  <SortableHead label="Поставщик" sortKey="supplier" sort={sort} onSort={handleSort} className="h-9 px-3 text-[11px]" />
                  <SortableHead label="Номер заказа" sortKey="orderNumber" sort={sort} onSort={handleSort} className="h-9 px-3 text-[11px]" />
                  <SortableHead label="Поставка" sortKey="supplyType" sort={sort} onSort={handleSort} className="h-9 px-3 text-[11px]" />
                  <SortableHead label="Хранение" sortKey="storageType" sort={sort} onSort={handleSort} className="h-9 px-3 text-[11px]" />
                  <SortableHead label="SKU" sortKey="sku" sort={sort} onSort={handleSort} className="h-9 px-3 text-center text-[11px]" />
                  <SortableHead label="Штук" sortKey="pieces" sort={sort} onSort={handleSort} className="h-9 px-3 text-center text-[11px]" />
                  <SortableHead label="Вес, кг" sortKey="weightKg" sort={sort} onSort={handleSort} className="h-9 px-3 text-center text-[11px]" />
                  {recon && <>
                    <SortableHead label="Факт SKU" sortKey="fact.sku" sort={sort} onSort={handleSort} className={cn('h-9 px-3 text-center text-[11px]', G)} />
                    <SortableHead label="Факт шт" sortKey="fact.pieces" sort={sort} onSort={handleSort} className="h-9 px-3 text-center text-[11px]" />
                    <SortableHead label="Факт кг" sortKey="fact.weightKg" sort={sort} onSort={handleSort} className="h-9 px-3 text-center text-[11px]" />
                    <SortableHead label="Статус" sortKey="status" sort={sort} onSort={handleSort} className="h-9 px-3 text-[11px]" />
                    <TableHead className="h-9 px-3 text-[11px]" title="Время завершения задания в WMS — у «Не проверена»/«Отменена» оно тоже есть">Завершена в WMS</TableHead>
                  </>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {tableRows.map(r => {
                  const piecesDiff = r.fact && r.pieces ? pct(r.fact.pieces, r.pieces) : null
                  return (
                    <TableRow key={`${r.orderNumber}-${r.status}`}>
                      <TableCell className="px-3 py-1.5 text-[13px]">{r.supplier || '—'}</TableCell>
                      <TableCell className="px-3 py-1.5 font-mono text-xs">{r.orderNumber}</TableCell>
                      <TableCell className="px-3 py-1.5 text-[13px]">{r.status === 'extra' ? (r.supplyType === 'CROSSDOCK' ? 'Кросс-докинг' : 'Хранение') : r.supplyType}</TableCell>
                      <TableCell className="px-3 py-1.5 text-[13px]">{r.status === 'extra' ? '' : r.storageType}</TableCell>
                      <TableCell className="tabular px-3 py-1.5 text-center text-[13px]">{r.status === 'extra' ? '' : fmtNum(r.sku)}</TableCell>
                      <TableCell className="tabular px-3 py-1.5 text-center text-[13px]">{r.status === 'extra' ? '' : fmtNum(r.pieces)}</TableCell>
                      <TableCell className="tabular px-3 py-1.5 text-center text-[13px]">{r.status === 'extra' ? '' : fmtNum(r.weightKg)}</TableCell>
                      {recon && <>
                        <TableCell className={cn('tabular px-3 py-1.5 text-center text-[13px]', G)}>{r.fact ? fmtNum(r.fact.sku) : '—'}</TableCell>
                        <TableCell className={cn('tabular px-3 py-1.5 text-center text-[13px]', piecesDiff != null && Math.abs(piecesDiff) >= 0.05 && 'font-semibold text-warning')}>{r.fact ? fmtNum(r.fact.pieces) : '—'}</TableCell>
                        <TableCell className="tabular px-3 py-1.5 text-center text-[13px]">{r.fact ? fmtNum(r.fact.weightKg) : '—'}</TableCell>
                        <TableCell className="px-3 py-1.5"><span title={r.wmsStatus ? `Статус в WMS: ${WMS_STATUS_LABELS[r.wmsStatus] || r.wmsStatus}` : undefined} className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', STATUS[r.status].cls)}>{STATUS[r.status].label}{r.status === 'inProgress' && r.wmsStatus ? ` · ${WMS_STATUS_LABELS[r.wmsStatus] || r.wmsStatus}` : ''}</span></TableCell>
                        <TableCell className="px-3 py-1.5 text-[12px] text-muted-foreground">{fmtTime(r.completedAt)}</TableCell>
                      </>}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            Сверка — по номеру заказа: задания WMS с плановым прибытием ±1 день и принятые в смены этой даты. «Вне графика» — принятые с 09:00 этого дня до 09:00 следующего, которых нет в графике. Факт — только у принятых (как в WMS); «Не проверена» — приёмка в WMS завершена, но поставка ещё ждёт проверки. Факт SKU — число товаров в задании WMS. Жёлтым — штуки разошлись с планом на 5% и больше.
          </p>
        </>
      )}
    </div>
  )
}
