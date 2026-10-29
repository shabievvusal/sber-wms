import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DateRangePicker, DateTimeRangePicker } from '@/components/ui/date-picker'
import { CompanyFilter } from '@/pages/stats/CompanyFilter'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableHeader, TableBody, TableRow, TableCell } from '@/components/ui/table'
import { SortableHead } from '@/components/ui/sortable-head'
import { cn } from '@/lib/utils'
import { Copy, Download, FileSpreadsheet, Image } from 'lucide-react'
import { NUM, DEC1, PCT, addTable, titleRows } from '@/pages/stats/receivingExport'
import { METRICS, OPS, compareToNorm, mainLabelOf, mainOf, opMeta, shiftSummary } from './workloadCalc'
import { copyShiftPng, downloadShiftPng } from './shiftImage'

const WEEKDAY_FULL = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота']
const SHIFT_GEN = { day: 'дневной', night: 'ночной' }
const fmtD = d => (d ? d.split('-').reverse().join('.') : '')
const fmtNum = v => (v == null ? '—' : Math.round(v).toLocaleString('ru-RU'))
const fmtDec = v => (v == null ? '—' : v.toLocaleString('ru-RU', { maximumFractionDigits: 1 }))
const fmtPct = v => (v == null ? '—' : `${Math.round(v * 100)}%`)
const fmtTrend = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`)
const mskNow = () => new Date(Date.now() + 3 * 3600_000)
const shiftDay = (d, k) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10) }

async function saveWb(wb, fileName) {
  const buf = await wb.xlsx.writeBuffer()
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function Segmented({ value, onChange, options }) {
  return (
    <div className="flex rounded-full border border-line bg-card p-0.5">
      {options.map(([k, label]) => (
        <button key={k} type="button" onClick={() => onChange(k)}
          className={cn('rounded-full px-3.5 py-1 text-sm', value === k ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}>{label}</button>
      ))}
    </div>
  )
}

// «Итоги смены»: итог смены по всем операциям (картинка в чат, Excel) и
// сравнение выработки сотрудников с нормой за период.
export default function ShiftSummaryPage() {
  const [tab, setTab] = useState('shift')
  return (
    <div className="mx-auto w-full space-y-4 p-6">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Итоги смены</h1>
          <p className="text-sm text-muted-foreground">Итог смены по всем операциям одной картинкой и выработка сотрудников к норме</p>
        </div>
        <div className="ml-auto"><Segmented value={tab} onChange={setTab} options={[['shift', 'Итог смены'], ['norm', 'Сравнение с нормой']]} /></div>
      </div>
      {tab === 'shift' ? <ShiftTab /> : <NormTab />}
    </div>
  )
}

// ── Итог смены ──────────────────────────────────────────────────────────────
// "YYYY-MM-DDTHH:mm" по Москве ↔ ISO
const toIso = local => new Date(`${local}:00+03:00`).toISOString()
const fmtLocal = local => `${fmtD(local.slice(0, 10))} ${local.slice(11, 16)}`

// текущая смена: 09–21 — сегодняшний день, 21–24 — ночь с сегодня на завтра,
// 00–09 — ночь со вчера на сегодня (данные — по текущий момент)
function currentShiftRange() {
  const n = mskNow(), h = n.getUTCHours(), today = n.toISOString().slice(0, 10)
  if (h >= 9 && h < 21) return { from: `${today}T09:00`, to: `${today}T21:00` }
  if (h >= 21) return { from: `${today}T21:00`, to: `${shiftDay(today, 1)}T09:00` }
  return { from: `${shiftDay(today, -1)}T21:00`, to: `${today}T09:00` }
}

// заголовок картинки: ровно смена — «Итоги дневной смены · Среда, 28.10.2026», иначе интервал
function rangeTitle({ from, to }) {
  const d = from.slice(0, 10), wd = WEEKDAY_FULL[new Date(`${d}T00:00:00Z`).getUTCDay()]
  if (from.slice(11) === '09:00' && to === `${d}T21:00`) return { title: `Итоги дневной смены · ${wd}, ${fmtD(d)}`, sub: 'с 09:00 до 21:00', file: `итог_день_${d}` }
  if (from.slice(11) === '21:00' && to === `${shiftDay(d, 1)}T09:00`) return { title: `Итоги ночной смены · ${wd}, ${fmtD(d)}`, sub: `с 21:00 ${fmtD(d)} до 09:00 ${fmtD(shiftDay(d, 1))}`, file: `итог_ночь_${d}` }
  return { title: `Итоги за ${fmtLocal(from)} — ${fmtLocal(to)}`, sub: 'по времени завершения операций (МСК)', file: `итог_${from.replace(/[T:]/g, '-')}_${to.replace(/[T:]/g, '-')}` }
}

function ShiftTab() {
  const [range, setRange] = useState(currentShiftRange)
  const [data, setData] = useState(null) // { [op]: rows }
  const [loading, setLoading] = useState(false)
  const [company, setCompany] = useState('__all__')

  useEffect(() => {
    if (!range.from || !range.to) return
    let alive = true
    setLoading(true)
    const from = toIso(range.from), to = toIso(range.to)
    Promise.all(OPS.map(o => api.getWorkloadInterval(o.key, from, to).then(r => [o.key, r.rows || []]).catch(() => [o.key, null])))
      .then(list => { if (alive) setData(Object.fromEntries(list)) })
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [range.from, range.to])

  const companies = useMemo(() => {
    const set = new Set()
    for (const rows of Object.values(data || {})) for (const r of rows || []) if (r.company && r.company !== '—') set.add(r.company)
    return [...set].sort((a, b) => a.localeCompare(b, 'ru'))
  }, [data])
  const byCompany = r => company === '__all__' || (company === '__none__' ? !r.company || r.company === '—' : r.company === company)

  const blocks = useMemo(() => (data ? OPS.map(o => {
    const rows = (data[o.key] || []).filter(byCompany)
    if (!rows.length) return null
    const main = mainOf(o)
    const mainLabel = mainLabelOf(o)
    return { ...o, mainLabel, mainShort: o.main ? mainLabel : o.unitShort, summary: shiftSummary(rows, 5, main), full: shiftSummary(rows, 10, main) }
  }).filter(Boolean) : []), [data, company]) // eslint-disable-line react-hooks/exhaustive-deps
  const failed = data ? OPS.filter(o => data[o.key] == null).map(o => o.label) : []
  const head = range.from && range.to ? rangeTitle(range) : null
  const companyLabel = company === '__all__' ? '' : company === '__none__' ? 'не в списке компаний' : company
  const imageOpts = () => ({ title: head.title, subtitle: [head.sub, companyLabel].filter(Boolean).join(' · '), blocks })
  const fileBase = head ? head.file + (companyLabel ? `_${companyLabel.replace(/\s+/g, '_')}` : '') : 'итог'

  const exportXlsx = async () => {
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    wb.creator = 'ВС'
    const sub = [head.title, companyLabel].filter(Boolean).join(' · ')
    {
      const ws = wb.addWorksheet('Итог')
      const cols = [
        { header: 'Операция', key: 'label', width: 20 },
        { header: 'Главный показатель', key: 'mainLabel', width: 13 },
        { header: 'Значение', key: 'main', numFmt: NUM, width: 12 },
        { header: 'Операций', key: 'units', numFmt: NUM, width: 11 },
        { header: 'Штук', key: 'qty', numFmt: NUM, width: 12 },
        { header: 'Вес, кг', key: 'kg', numFmt: NUM, width: 12 },
        { header: 'Сотрудников', key: 'people', numFmt: NUM, width: 12 },
        { header: 'В час на чел.', key: 'perHour', numFmt: DEC1, width: 12 },
      ]
      titleRows(ws, 'Итог смены', sub, cols.length)
      addTable(ws, cols, blocks.map(b => ({ label: b.label, mainLabel: b.mainLabel, ...b.summary })))
    }
    for (const b of blocks) {
      const ws = wb.addWorksheet(b.label)
      const isRecv = b.key === 'receiving'
      const cols = [
        { header: 'Сотрудник', key: 'name', width: 34 },
        { header: 'Компания', key: 'company', width: 18 },
        ...(isRecv ? [{ header: 'SKU', key: 'sku', numFmt: NUM, width: 10 }] : []),
        { header: b.unit[0].toUpperCase() + b.unit.slice(1), key: 'units', numFmt: NUM, width: 11 },
        { header: 'Штук', key: 'qty', numFmt: NUM, width: 11 },
        { header: 'Вес, кг', key: 'kg', numFmt: NUM, width: 11 },
        { header: `${b.mainLabel} в час`, key: 'perHour', numFmt: DEC1, width: 11 },
      ]
      titleRows(ws, `${b.label} — ${sub}`, '«в час» — на отработанный час (часы, в которые были завершённые операции)', cols.length)
      const main = mainOf(b)
      addTable(ws, cols, b.summary.all.map(p => ({ ...p, kg: p.grams / 1000, perHour: p.hours ? p[main] / p.hours : null })), { freezeCols: 1, total: { name: 'Итого', sku: b.summary.sku, units: b.summary.units, qty: b.summary.qty, kg: b.summary.kg, perHour: b.summary.perHour } })
    }
    await saveWb(wb, `${fileBase}.xlsx`)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-card p-3 shadow-card">
        <DateTimeRangePicker className="h-9 w-80" from={range.from} to={range.to} onChange={r => r.from && r.to && setRange(r)} placeholder="Период" />
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" disabled={!blocks.length} onClick={() => downloadShiftPng(imageOpts(), `${fileBase}.png`).catch(err => toast.error(err.message))}><Image className="size-4" /> PNG</Button>
          <Button variant="outline" disabled={!blocks.length} onClick={() => copyShiftPng(imageOpts()).then(() => toast.success('Картинка скопирована — вставьте в чат (Ctrl+V)')).catch(err => toast.error(err.message))}><Copy className="size-4" /> Копировать</Button>
          <Button variant="secondary" disabled={!blocks.length} onClick={() => exportXlsx().catch(err => toast.error(err.message))}><Download className="size-4" /> Excel</Button>
        </div>
      </div>
      {companies.length > 0 && <CompanyFilter companies={companies} value={company} onChange={setCompany} />}

      {loading && <Spinner label="Загрузка смены…" />}
      {!loading && failed.length > 0 && <div className="text-xs text-destructive">Не загрузилось: {failed.join(', ')}</div>}
      {!loading && data && !blocks.length && (
        <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">За этот период данных нет{companyLabel ? ` по «${companyLabel}»` : ''} — обновите статистику смены</div>
      )}
      {!loading && blocks.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-2">
          {blocks.map(b => (
            <div key={b.key} className="overflow-hidden rounded-2xl border border-line bg-card shadow-card">
              <div className="flex items-center justify-between bg-muted/40 px-4 py-2.5">
                <span className="font-semibold">{b.label}</span>
                <span className="text-sm text-muted-foreground">{b.summary.people} чел.</span>
              </div>
              <div className="grid grid-cols-4 border-b border-line py-3">
                {[[b.mainLabel, fmtNum(b.summary.main)], ['штук', fmtNum(b.summary.qty)], ['кг', fmtNum(b.summary.kg)], [`${b.mainShort} в час на чел.`, fmtDec(b.summary.perHour)]].map(([l, v]) => (
                  <div key={l} className="text-center">
                    <div className="tabular text-xl font-semibold">{v}</div>
                    <div className="text-[11px] text-muted-foreground">{l}</div>
                  </div>
                ))}
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th className="px-4 py-1.5 text-left font-normal">Сотрудник</th>
                    <th className="w-20 py-1.5 text-center font-normal">{b.mainShort}</th>
                    {b.key === 'receiving' && <th className="w-20 py-1.5 text-center font-normal">поставок</th>}
                    <th className="w-20 py-1.5 text-center font-normal">шт</th>
                    <th className="w-20 py-1.5 text-center font-normal">в час</th>
                  </tr>
                </thead>
                <tbody>
                  {b.full.top.map((p, i) => (
                    <tr key={p.key} className="border-t border-line">
                      <td className="px-4 py-1.5"><span className="mr-1.5 text-muted-foreground">{i + 1}.</span>{p.name || '—'}</td>
                      <td className="py-1.5 text-center font-semibold tabular-nums">{fmtNum(p.main)}</td>
                      {b.key === 'receiving' && <td className="py-1.5 text-center tabular-nums">{fmtNum(p.units)}</td>}
                      <td className="py-1.5 text-center tabular-nums">{fmtNum(p.qty)}</td>
                      <td className="py-1.5 text-center tabular-nums text-muted-foreground">{fmtDec(p.perHour)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {b.summary.people > 10 && <div className="px-4 py-1.5 text-xs text-muted-foreground">и ещё {b.summary.people - 10} — все в Excel</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Сравнение с нормой ──────────────────────────────────────────────────────
const NORM_COLS = [
  { key: 'name', label: 'Сотрудник', text: true },
  { key: 'company', label: 'Компания', text: true },
  { key: 'shifts', label: 'Смен' },
  { key: 'value', label: 'Всего' },
  { key: 'perShift', label: 'За смену' },
  { key: 'rate', label: 'В час' },
  { key: 'toNorm', label: 'К норме' },
  { key: 'trend', label: 'Динамика' },
]

function NormTab() {
  const y = shiftDay(mskNow().toISOString().slice(0, 10), -1)
  const [range, setRange] = useState({ from: shiftDay(y, -29), to: y })
  const [op, setOp] = useState('kdk')
  const [shift, setShift] = useState('')
  const [metric, setMetric] = useState('units')
  const [minHours, setMinHours] = useState(10)
  const [rows, setRows] = useState(null)
  const [loading, setLoading] = useState(false)
  const [sort, setSort] = useState({ key: 'toNorm', dir: 'asc' })
  const [search, setSearch] = useState('')

  useEffect(() => { setMetric(opMeta(op).metric) }, [op])
  useEffect(() => {
    if (!range.from || !range.to) return
    let alive = true
    setLoading(true)
    api.getWorkload(op, range.from, range.to, shift || undefined)
      .then(r => alive && setRows(r.rows || []))
      .catch(err => { if (alive) { setRows(null); toast.error(err.message) } })
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [op, range.from, range.to, shift])

  const result = useMemo(() => (rows ? compareToNorm(rows, { metric, from: range.from, to: range.to, minHours: Number(minHours) || 0 }) : null), [rows, metric, range, minHours])
  const list = useMemo(() => {
    if (!result) return []
    const q = search.trim().toLowerCase()
    const l = q ? result.people.filter(p => p.name.toLowerCase().includes(q) || p.company.toLowerCase().includes(q)) : [...result.people]
    const text = NORM_COLS.find(c => c.key === sort.key)?.text
    return l.sort((a, b) => {
      // мало данных — всегда внизу
      if (a.enough !== b.enough) return a.enough ? -1 : 1
      const cmp = text ? String(a[sort.key]).localeCompare(String(b[sort.key]), 'ru') : (a[sort.key] ?? -Infinity) - (b[sort.key] ?? -Infinity)
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [result, sort, search])
  const handleSort = key => setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: NORM_COLS.find(c => c.key === key)?.text ? 'asc' : 'desc' }))

  const meta = opMeta(op)
  const mLabel = METRICS[metric].label(op)
  const below = result ? result.people.filter(p => p.enough && p.toNorm != null && p.toNorm < 0.8).length : 0
  const above = result ? result.people.filter(p => p.enough && p.toNorm != null && p.toNorm >= 1.2).length : 0

  const exportXlsx = async () => {
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    wb.creator = 'ВС'
    const ws = wb.addWorksheet('К норме')
    const cols = [
      { header: 'Сотрудник', key: 'name', width: 34 },
      { header: 'Компания', key: 'company', width: 18 },
      { header: 'Смен', key: 'shifts', numFmt: NUM, width: 8 },
      { header: `Всего, ${mLabel}`, key: 'value', numFmt: NUM, width: 12 },
      { header: `За смену, ${mLabel}`, key: 'perShift', numFmt: DEC1, width: 12 },
      { header: `В час, ${mLabel}`, key: 'rate', numFmt: DEC1, width: 11 },
      { header: 'К норме', key: 'toNorm', numFmt: PCT, width: 10 },
      { header: 'Динамика', key: 'trend', numFmt: PCT, width: 10 },
      { header: 'Мало данных', key: 'few', width: 10 },
    ]
    titleRows(ws, `${meta.label}: выработка к норме — ${fmtD(range.from)} — ${fmtD(range.to)}${shift ? ` (${SHIFT_GEN[shift]} смены)` : ''}`,
      `норма — медиана выработки в час: ${fmtDec(result.norm)} ${mLabel}/ч (по ${result.counted} сотрудникам, у кого от ${minHours} часов). Динамика — вторая половина периода к первой.`, cols.length)
    addTable(ws, cols, list.map(p => ({ ...p, few: p.enough ? '' : 'да' })), { freezeCols: 1 })
    await saveWb(wb, `норма_${meta.label.replace(/\s+/g, '_')}_${range.from}_${range.to}.xlsx`)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-card p-3 shadow-card">
        <DateRangePicker className="h-9 w-60" from={range.from} to={range.to} onChange={({ from, to }) => setRange({ from, to })} />
        <Segmented value={shift} onChange={setShift} options={[['', 'Обе смены'], ['day', 'День'], ['night', 'Ночь']]} />
        <Segmented value={metric} onChange={setMetric} options={Object.keys(METRICS).filter(k => !METRICS[k].only || METRICS[k].only.includes(op)).map(k => [k, METRICS[k].label(op)])} />
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground" title="Сотрудники с меньшим числом часов не входят в расчёт нормы">
          в норме от <Input className="h-8 w-16 text-center" type="number" min={0} value={minHours} onChange={e => setMinHours(e.target.value)} /> ч
        </label>
        <Button className="ml-auto" variant="secondary" disabled={!list.length} onClick={() => exportXlsx().catch(err => toast.error(err.message))}><FileSpreadsheet className="size-4" /> Excel</Button>
      </div>

      <div className="flex flex-wrap gap-1">
        {OPS.map(o => <Button key={o.key} size="sm" className="h-8" variant={op === o.key ? 'default' : 'ghost'} onClick={() => setOp(o.key)}>{o.label}</Button>)}
      </div>

      {loading && <Spinner label="Загрузка выработки…" />}
      {!loading && result && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label={`Норма, ${mLabel} в час`} value={fmtDec(result.norm)} hint={`медиана по ${result.counted} сотр.`} />
            <Tile label="Сотрудников" value={fmtNum(result.people.length)} hint={`в расчёте нормы ${result.counted}`} />
            <Tile label="Ниже 80% нормы" value={fmtNum(below)} tone="bad" />
            <Tile label="Выше 120% нормы" value={fmtNum(above)} tone="good" />
          </div>
          <Input className="h-8 max-w-xs" value={search} onChange={e => setSearch(e.target.value)} placeholder="Сотрудник или компания" />
          <div className="max-h-[70vh] overflow-auto rounded-2xl border border-line bg-card shadow-card">
            <Table className="[&_td+td]:border-l [&_td+td]:border-l-line [&_th+th]:border-l [&_th+th]:border-l-line">
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  {NORM_COLS.map(c => <SortableHead key={c.key} label={c.key === 'value' ? `Всего, ${mLabel}` : c.label} sortKey={c.key} sort={sort} onSort={handleSort} className={cn('h-9 px-3 text-[11px]', !c.text && 'text-center')} />)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map(p => (
                  <TableRow key={p.key} className={cn(!p.enough && 'text-muted-foreground')}>
                    <TableCell className="px-3 py-1.5 text-[13px]">{p.name}{!p.enough && <span className="ml-1.5 text-[11px]">· мало данных</span>}</TableCell>
                    <TableCell className="px-3 py-1.5 text-[13px]">{p.company}</TableCell>
                    <TableCell className="px-3 py-1.5 text-center text-[13px] tabular-nums">{p.shifts}</TableCell>
                    <TableCell className="px-3 py-1.5 text-center text-[13px] tabular-nums">{fmtNum(p.value)}</TableCell>
                    <TableCell className="px-3 py-1.5 text-center text-[13px] tabular-nums">{fmtDec(p.perShift)}</TableCell>
                    <TableCell className="px-3 py-1.5 text-center text-[13px] font-semibold tabular-nums">{fmtDec(p.rate)}</TableCell>
                    <TableCell className={cn('px-3 py-1.5 text-center text-[13px] font-semibold tabular-nums', p.enough && p.toNorm != null && (p.toNorm < 0.8 ? 'text-destructive' : p.toNorm >= 1.2 ? 'text-success' : ''))}>{fmtPct(p.toNorm)}</TableCell>
                    <TableCell className={cn('px-3 py-1.5 text-center text-[13px] tabular-nums', p.trend != null && Math.abs(p.trend) >= 0.1 && (p.trend < 0 ? 'text-destructive' : 'text-success'))}>{fmtTrend(p.trend)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            «В час» — на отработанный час: часы, в которые у сотрудника были завершённые операции. Норма — медиана выработки в час среди сотрудников, у кого за период не меньше указанного числа часов. «Динамика» — выработка в час во второй половине периода против первой (нужно от 3 часов в каждой). Красным — ниже 80% нормы, зелёным — от 120%.
          </p>
        </>
      )}
    </div>
  )
}

function Tile({ label, value, hint, tone }) {
  return (
    <div className="rounded-3xl border border-line bg-card p-4 shadow-card">
      <div className="text-[13px] font-medium text-ink-2">{label}</div>
      <div className={cn('tabular mt-2 text-[26px] font-semibold leading-tight tracking-tight', tone === 'bad' && 'text-destructive', tone === 'good' && 'text-success')}>{value}</div>
      {hint && <div className="mt-1 text-sm text-muted-foreground">{hint}</div>}
    </div>
  )
}
