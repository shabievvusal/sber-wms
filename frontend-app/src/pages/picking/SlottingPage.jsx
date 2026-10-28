import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DateRangePicker } from '@/components/ui/date-picker'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { ArrowLeftRight, Download } from 'lucide-react'
import { NUM, PCT, addTable, titleRows } from '@/pages/stats/receivingExport'
import { analyzeSlotting } from './slottingCalc'

const LS_DIRS = 'slotting_dirs'
const shiftDay = (d, k) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10) }
const fmtD = d => (d ? d.split('-').reverse().join('.') : '')
const fmtNum = v => (v == null ? '—' : Math.round(v).toLocaleString('ru-RU'))
const fmtPct = v => (v == null ? '—' : `${Math.round(v * 100)}%`)
const readDirs = () => { try { return JSON.parse(localStorage.getItem(LS_DIRS) || '{}') } catch { return {} } }

function Tile({ label, value, hint }) {
  return (
    <div className="rounded-3xl border border-line bg-card p-4 shadow-card">
      <div className="text-[13px] font-medium text-ink-2">{label}</div>
      <div className="tabular mt-2 text-[26px] font-semibold leading-tight tracking-tight">{value}</div>
      {hint && <div className="mt-1 text-sm text-muted-foreground">{hint}</div>}
    </div>
  )
}

function Toggle({ value, onChange, options }) {
  return (
    <div className="flex rounded-full border border-line bg-card p-0.5">
      {options.map(([k, label]) => (
        <button key={String(k)} type="button" onClick={() => onChange(k)}
          className={cn('rounded-full px-3 py-1 text-xs', value === k ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}>{label}</button>
      ))}
    </div>
  )
}

// «Расстановка товара»: частые товары штучного отбора — в ближнюю часть
// маршрута, редкие — дальше. Частота — строки отбора за период из WMS.
export default function SlottingPage() {
  const y = shiftDay(new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10), -1)
  const [range, setRange] = useState({ from: shiftDay(y, -29), to: y })
  const [rows, setRows] = useState(null)
  const [loading, setLoading] = useState(false)
  const [goldenPct, setGoldenPct] = useState(20)
  const [dirs, setDirs] = useState(readDirs)
  const [zone, setZone] = useState(null)

  useEffect(() => {
    if (!range.from || !range.to) return
    let alive = true
    setLoading(true)
    api.getSlotting(range.from, range.to)
      .then(r => alive && setRows(r.rows || []))
      .catch(err => { if (alive) { setRows(null); toast.error(err.message) } })
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [range.from, range.to])

  const zones = useMemo(() => (rows ? analyzeSlotting(rows, { goldenPct: Math.min(80, Math.max(1, Number(goldenPct) || 20)), dirs }) : []), [rows, goldenPct, dirs])
  useEffect(() => { if (zones.length && !zones.some(z => z.zone === zone)) setZone(zones[0].zone) }, [zones, zone])
  const z = zones.find(x => x.zone === zone)

  const setDir = (k, v) => setDirs(prev => {
    const next = { ...prev, [zone]: { ...(prev[zone] || {}), [k]: v } }
    try { localStorage.setItem(LS_DIRS, JSON.stringify(next)) } catch { /* без сохранения */ }
    return next
  })
  const maxRowLines = z ? Math.max(1, ...z.rows.map(r => r.lines)) : 1

  const exportXlsx = async () => {
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    wb.creator = 'ВС'
    const period = `${fmtD(range.from)} — ${fmtD(range.to)}`
    {
      const ws = wb.addWorksheet('Зоны')
      const cols = [
        { header: 'Зона', key: 'zone', width: 10 },
        { header: 'Ячеек', key: 'cells', numFmt: NUM, width: 10 },
        { header: 'Ячеек в ближней зоне', key: 'goldenN', numFmt: NUM, width: 13 },
        { header: 'Товаров с отборами', key: 'products', numFmt: NUM, width: 12 },
        { header: 'Строк отбора', key: 'totalLines', numFmt: NUM, width: 12 },
        { header: 'Отборов в ближней зоне сейчас', key: 'goldenShare', numFmt: PCT, width: 15 },
        { header: 'Можно', key: 'idealShare', numFmt: PCT, width: 10 },
        { header: 'Перестановок', key: 'movesN', numFmt: NUM, width: 12 },
      ]
      titleRows(ws, `Расстановка товара — ${period}`, `штучный отбор; ближняя зона — первые ${goldenPct}% ячеек зоны по маршруту`, cols.length)
      addTable(ws, cols, zones.map(x => ({ ...x, movesN: x.moves.length })))
    }
    {
      const ws = wb.addWorksheet('Перестановки')
      const cols = [
        { header: 'Зона', key: 'zone', width: 8 },
        { header: 'Частый товар', key: 'fastName', width: 40 },
        { header: 'Код', key: 'fastCode', width: 12 },
        { header: 'Строк отбора', key: 'fastLines', numFmt: NUM, width: 11 },
        { header: 'Сейчас в ячейке', key: 'fastCell', width: 16 },
        { header: 'Перенести в ячейку', key: 'slowCell', width: 16 },
        { header: 'Редкий товар оттуда', key: 'slowName', width: 40 },
        { header: 'Код', key: 'slowCode', width: 12 },
        { header: 'Строк отбора', key: 'slowLines', numFmt: NUM, width: 11 },
        { header: 'Выигрыш, обращений ближе', key: 'gain', numFmt: NUM, width: 13 },
      ]
      titleRows(ws, `Перестановки — ${period}`, 'частый товар из дальней ячейки ⇄ редкий из ближней; проверьте габариты ячеек перед перестановкой', cols.length)
      addTable(ws, cols, zones.flatMap(x => x.moves).map(m => ({
        zone: m.zone, fastName: m.fast.name, fastCode: m.fast.code, fastLines: m.fast.lines, fastCell: m.fastCell,
        slowCell: m.slowCell, slowName: m.slow?.name || 'нет отборов за период', slowCode: m.slow?.code || '', slowLines: m.slow?.lines || 0, gain: m.gain,
      })), { freezeCols: 2 })
    }
    {
      const ws = wb.addWorksheet('Ячейки')
      const cols = [
        { header: 'Ячейка', key: 'cell', width: 16 },
        { header: 'Зона', key: 'zone', width: 8 },
        { header: 'Порядок по маршруту', key: 'order', numFmt: NUM, width: 11 },
        { header: 'Ближняя зона', key: 'golden', width: 10 },
        { header: 'Товар', key: 'name', width: 40 },
        { header: 'Код', key: 'code', width: 12 },
        { header: 'Строк отбора товара', key: 'lines', numFmt: NUM, width: 12 },
        { header: 'Класс', key: 'cls', width: 8 },
      ]
      titleRows(ws, `Ячейки штучного отбора — ${period}`, 'класс A — самые частые товары зоны, C — нижняя половина по частоте', cols.length)
      addTable(ws, cols, zones.flatMap(x => x.slots).map(s => ({
        cell: s.cell, zone: s.zone, order: s.rank + 1, golden: s.golden ? 'да' : '', name: s.product?.name || '', code: s.product?.code || '', lines: s.product?.lines ?? null, cls: s.cls || '',
      })), { freezeCols: 1 })
    }
    const buf = await wb.xlsx.writeBuffer()
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `расстановка_${range.from}_${range.to}.xlsx`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="mx-auto w-full space-y-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Расстановка товара</h1>
        <p className="text-sm text-muted-foreground">Частые товары штучного отбора — в начало маршрута, редкие — дальше. Частота — строки отбора за период</p>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-card p-3 shadow-card">
        <DateRangePicker className="h-9 w-60" from={range.from} to={range.to} onChange={({ from, to }) => setRange({ from, to })} />
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground" title="Какая доля ячеек зоны в начале маршрута считается ближней">
          ближняя зона <Input className="h-8 w-16 text-center" type="number" min={1} max={80} value={goldenPct} onChange={e => setGoldenPct(e.target.value)} /> % ячеек
        </label>
        <Button className="ml-auto" variant="secondary" disabled={!zones.length} onClick={() => exportXlsx().catch(err => toast.error(err.message))}><Download className="size-4" /> Excel</Button>
      </div>

      {loading && <Spinner label="Загрузка отборов…" />}
      {!loading && rows && !zones.length && (
        <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">За период нет штучного отбора — обновите статистику комплектации</div>
      )}

      {!loading && zones.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-1">
            {zones.map(x => <Button key={x.zone} size="sm" className="h-8" variant={zone === x.zone ? 'default' : 'ghost'} onClick={() => setZone(x.zone)}>{x.zone} · {x.moves.length}</Button>)}
          </div>

          {z && (
            <>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="text-muted-foreground">Начало маршрута в зоне {z.zone}:</span>
                <span className="text-xs text-muted-foreground">ряды</span>
                <Toggle value={!!dirs[zone]?.rowsDesc} onChange={v => setDir('rowsDesc', v)} options={[[false, 'с первого'], [true, 'с последнего']]} />
                <span className="text-xs text-muted-foreground">секции</span>
                <Toggle value={!!dirs[zone]?.sectionsDesc} onChange={v => setDir('sectionsDesc', v)} options={[[false, 'с первой'], [true, 'с последней']]} />
              </div>

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Tile label="Ячеек отбора" value={fmtNum(z.cells)} hint={`ближняя зона — ${fmtNum(z.goldenN)}`} />
                <Tile label="Строк отбора" value={fmtNum(z.totalLines)} hint={`товаров ${fmtNum(z.products)}`} />
                <Tile label="Отборов в ближней зоне" value={fmtPct(z.goldenShare)} hint={`можно ${fmtPct(z.idealShare)}`} />
                <Tile label="Перестановок" value={fmtNum(z.moves.length)} hint={z.moves.length ? `ближе станет ${fmtNum(z.moves.reduce((s, m) => s + m.gain, 0))} обращений` : 'расстановка уже хорошая'} />
              </div>

              <div className="grid gap-4 xl:grid-cols-[1fr_300px]">
                <div className="overflow-x-auto rounded-2xl border border-line bg-card shadow-card">
                  <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-sm font-semibold"><ArrowLeftRight className="size-4 text-primary" /> Что переставить</div>
                  {!z.moves.length ? <div className="p-6 text-center text-sm text-muted-foreground">Все частые товары уже в ближней зоне</div> : (
                    <div className="max-h-[65vh] overflow-auto">
                      <Table className="[&_td+td]:border-l [&_td+td]:border-l-line [&_th+th]:border-l [&_th+th]:border-l-line">
                        <TableHeader className="sticky top-0 z-10 bg-card">
                          <TableRow>
                            <TableHead className="h-9 px-3 text-[11px]">Частый товар</TableHead>
                            <TableHead className="h-9 px-3 text-center text-[11px]">Строк</TableHead>
                            <TableHead className="h-9 px-3 text-center text-[11px]">Сейчас</TableHead>
                            <TableHead className="h-9 px-3 text-center text-[11px]">Перенести в</TableHead>
                            <TableHead className="h-9 px-3 text-[11px]">Редкий товар оттуда</TableHead>
                            <TableHead className="h-9 px-3 text-center text-[11px]">Строк</TableHead>
                            <TableHead className="h-9 px-3 text-center text-[11px]">Выигрыш</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {z.moves.map(m => (
                            <TableRow key={m.fastCell}>
                              <TableCell className="px-3 py-1.5 text-[13px]">{m.fast.name}<div className="font-mono text-[11px] text-muted-foreground">{m.fast.code}</div></TableCell>
                              <TableCell className="px-3 py-1.5 text-center text-[13px] font-semibold tabular-nums">{fmtNum(m.fast.lines)}</TableCell>
                              <TableCell className="whitespace-nowrap px-3 py-1.5 text-center font-mono text-xs">{m.fastCell}</TableCell>
                              <TableCell className="whitespace-nowrap px-3 py-1.5 text-center font-mono text-xs font-semibold text-primary">{m.slowCell}</TableCell>
                              <TableCell className="px-3 py-1.5 text-[13px] text-muted-foreground">{m.slow ? m.slow.name : 'нет отборов за период'}</TableCell>
                              <TableCell className="px-3 py-1.5 text-center text-[13px] tabular-nums">{fmtNum(m.slow?.lines || 0)}</TableCell>
                              <TableCell className="px-3 py-1.5 text-center text-[13px] font-semibold tabular-nums text-success">+{fmtNum(m.gain)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-line bg-card p-4 shadow-card">
                  <div className="mb-2 text-sm font-semibold">Отборы по рядам</div>
                  <div className="space-y-1">
                    {z.rows.map(r => (
                      <div key={r.row} className="flex items-center gap-2 text-xs">
                        <span className={cn('w-12 shrink-0 tabular-nums', r.golden && 'font-semibold text-primary')}>ряд {r.row}</span>
                        <div className="h-3 flex-1 rounded bg-muted">
                          <div className="h-3 rounded bg-primary/70" style={{ width: `${(r.lines / maxRowLines) * 100}%` }} />
                        </div>
                        <span className="w-14 shrink-0 text-center tabular-nums">{fmtNum(r.lines)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 text-[11px] text-muted-foreground">синим — ряды, где есть ячейки ближней зоны</div>
                </div>
              </div>
            </>
          )}

          <p className="text-xs text-muted-foreground">
            Адрес ячейки: зона-ряд-секция-место-ярус. Порядок по маршруту — ряд, затем секция; с какого конца начинается маршрут, задаётся для каждой зоны и запоминается. Ближняя зона — первые {goldenPct}% ячеек зоны. Товар ячейки — по последнему отбору за период. Перестановки — только внутри зоны: самый частый товар из дальней ячейки меняется местами с самым редким из ближней. Выигрыш — на сколько обращений за период станет ближе. Перед перестановкой проверьте габариты товара и ячейки.
          </p>
        </>
      )}
    </div>
  )
}
