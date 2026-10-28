import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { DateRangePicker } from '@/components/ui/date-picker'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { SortableHead } from '@/components/ui/sortable-head'
import { Download, Trash2 } from 'lucide-react'
import { DT, NUM, PCT, addTable, excelDate, titleRows } from '@/pages/stats/receivingExport'

const mskDate = (shiftDays = 0) => new Date(Date.now() + 3 * 3600_000 + shiftDays * 86400_000).toISOString().slice(0, 10)
const fmtD = d => (d ? d.split('-').reverse().join('.') : '')
const fmtDt = iso => (iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')
const names = s => (s || '').split(', ').map(x => x.trim()).filter(Boolean)

const COLS = [
  { key: 'foundAt', label: 'Найдена' },
  { key: 'hu', label: 'ЕО' },
  { key: 'foundCell', label: 'Где нашли' },
  { key: 'targetCell', label: 'Числилась в ЗГЗ' },
  { key: 'sourceCell', label: 'Ячейка КДК' },
  { key: 'store', label: 'ЦФЗ' },
  { key: 'pickers', label: 'Комплектовал' },
  { key: 'mover', label: 'Перевёл в ЗГЗ' },
  { key: 'movedAt', label: 'Переведена' },
  { key: 'items', label: 'Товаров', num: true },
  { key: 'foundBy', label: 'Кто нашёл' },
  { key: 'note', label: 'Примечание' },
]

// Сводка: сколько найденных ЕО на человека / ЦФЗ, доля от всех найденных.
function tally(rows, pick) {
  const m = new Map()
  for (const r of rows) for (const k of pick(r)) m.set(k, (m.get(k) || 0) + 1)
  return [...m.entries()].map(([name, count]) => ({ name, count, share: rows.length ? count / rows.length : 0 })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'))
}

// «Журнал найденных»: ЕО, отмеченные «Нашли» в поиске потеряшек — где
// числилась и где нашли, кто комплектовал и кто переводил в ЗГЗ.
export function LostEoJournal() {
  const [range, setRange] = useState({ from: mskDate(-30), to: mskDate() })
  const [rows, setRows] = useState(null)
  const [loading, setLoading] = useState(false)
  const [sort, setSort] = useState({ key: 'foundAt', dir: 'desc' })

  const load = () => {
    if (!range.from || !range.to) return
    setLoading(true)
    api.getZgzFound(range.from, range.to).then(setRows).catch(err => { setRows([]); toast.error(err.message) }).finally(() => setLoading(false))
  }
  useEffect(load, [range.from, range.to]) // eslint-disable-line react-hooks/exhaustive-deps

  const sorted = useMemo(() => {
    const list = [...(rows || [])]
    const col = COLS.find(c => c.key === sort.key)
    return list.sort((a, b) => {
      const cmp = col?.num ? (a[sort.key] || 0) - (b[sort.key] || 0) : String(a[sort.key] || '').localeCompare(String(b[sort.key] || ''), 'ru')
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [rows, sort])
  const handleSort = key => setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))

  const summary = useMemo(() => {
    const list = rows || []
    return [
      { title: 'Комплектовал', items: tally(list, r => names(r.pickers)) },
      { title: 'Перевёл в ЗГЗ', items: tally(list, r => (r.mover ? [r.mover] : [])) },
      { title: 'ЦФЗ', items: tally(list, r => (r.store ? [r.store] : [])) },
    ]
  }, [rows])

  const remove = async r => {
    if (!window.confirm(`Удалить из журнала ЕО ${r.hu}?`)) return
    try { await api.deleteZgzFound(r.id); setRows(prev => prev.filter(x => x.id !== r.id)) } catch (err) { toast.error(err.message) }
  }

  const exportXlsx = async () => {
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    wb.creator = 'ВС'
    const period = `${fmtD(range.from)} — ${fmtD(range.to)}`
    {
      const ws = wb.addWorksheet('Найденные ЕО')
      const cols = COLS.map(c => ({ header: c.label, key: c.key, width: c.key === 'note' ? 30 : c.key === 'pickers' ? 34 : c.key === 'hu' ? 16 : 18, ...(c.num ? { numFmt: NUM } : {}), ...(['foundAt', 'movedAt'].includes(c.key) ? { numFmt: DT } : {}) }))
      titleRows(ws, `Журнал найденных ЕО — ${period}`, 'отмечены «Нашли» в поиске потеряшек', cols.length)
      addTable(ws, cols, sorted.map(r => ({ ...r, foundAt: excelDate(r.foundAt), movedAt: excelDate(r.movedAt) })), { freezeCols: 2 })
    }
    for (const s of summary) {
      const ws = wb.addWorksheet(s.title)
      const cols = [{ header: s.title, key: 'name', width: 36 }, { header: 'Найдено ЕО', key: 'count', numFmt: NUM, width: 12 }, { header: 'Доля', key: 'share', numFmt: PCT, width: 10 }]
      titleRows(ws, `${s.title}: найденные ЕО — ${period}`, `всего найдено ЕО: ${(rows || []).length}`, cols.length)
      addTable(ws, cols, s.items, { freezeCols: 1 })
    }
    const buf = await wb.xlsx.writeBuffer()
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `найденные_ЕО_${range.from}_${range.to}.xlsx`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-card p-3 shadow-card">
        <span className="text-xs text-muted-foreground">Найдены:</span>
        <DateRangePicker className="h-9 w-60" from={range.from} to={range.to} onChange={({ from, to }) => setRange({ from, to })} />
        <span className="text-sm text-muted-foreground">{rows ? `ЕО в журнале: ${rows.length}` : ''}</span>
        <Button className="ml-auto" variant="secondary" disabled={!rows?.length} onClick={() => exportXlsx().catch(err => toast.error(err.message))}><Download className="size-4" /> Excel</Button>
      </div>

      {loading && <Spinner label="Загрузка журнала…" />}
      {!loading && rows && !rows.length && (
        <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">За период найденных ЕО нет — отмечайте «Нашли» на карточке ЕО в «Подборе ЕО»</div>
      )}

      {!loading && rows?.length > 0 && (
        <>
          <div className="grid gap-3 lg:grid-cols-3">
            {summary.map(s => (
              <div key={s.title} className="rounded-2xl border border-line bg-card p-3 shadow-card">
                <div className="mb-2 text-sm font-semibold">{s.title} <span className="font-normal text-muted-foreground">— у кого теряются чаще</span></div>
                {!s.items.length ? <div className="text-sm text-muted-foreground">нет данных</div> : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-muted-foreground">
                        <th className="py-1 text-left font-normal">{s.title === 'ЦФЗ' ? 'ЦФЗ' : 'Сотрудник'}</th>
                        <th className="w-20 py-1 text-center font-normal">ЕО</th>
                        <th className="w-20 py-1 text-center font-normal">Доля</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.items.slice(0, 10).map(it => (
                        <tr key={it.name} className="border-t">
                          <td className="py-1 pr-2">{it.name}</td>
                          <td className="py-1 text-center font-semibold tabular-nums">{it.count}</td>
                          <td className="py-1 text-center tabular-nums text-muted-foreground">{Math.round(it.share * 100)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>

          <div className="overflow-x-auto rounded-2xl border border-line bg-card shadow-card">
            <Table className="[&_td+td]:border-l [&_td+td]:border-l-line [&_th+th]:border-l [&_th+th]:border-l-line">
              <TableHeader>
                <TableRow>
                  {COLS.map(c => <SortableHead key={c.key} label={c.label} sortKey={c.key} sort={sort} onSort={handleSort} className={`h-9 px-3 text-[11px]${c.num ? ' text-center' : ''}`} />)}
                  <TableHead className="h-9 w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map(r => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap px-3 py-1.5 text-[13px]">{fmtDt(r.foundAt)}</TableCell>
                    <TableCell className="px-3 py-1.5 font-mono text-xs">{r.hu}</TableCell>
                    <TableCell className="px-3 py-1.5 text-[13px] font-semibold">{r.foundCell || '—'}</TableCell>
                    <TableCell className="px-3 py-1.5 text-[13px]">{r.targetCell || '—'}</TableCell>
                    <TableCell className="px-3 py-1.5 text-[13px]">{r.sourceCell || '—'}</TableCell>
                    <TableCell className="px-3 py-1.5 text-[13px]">{r.store || '—'}</TableCell>
                    <TableCell className="px-3 py-1.5 text-[13px]">{r.pickers || '—'}</TableCell>
                    <TableCell className="px-3 py-1.5 text-[13px]">{r.mover || '—'}</TableCell>
                    <TableCell className="whitespace-nowrap px-3 py-1.5 text-[13px]">{fmtDt(r.movedAt)}</TableCell>
                    <TableCell className="px-3 py-1.5 text-center text-[13px] tabular-nums">{r.items}</TableCell>
                    <TableCell className="px-3 py-1.5 text-[13px]">{r.foundBy || '—'}</TableCell>
                    <TableCell className="px-3 py-1.5 text-[13px] text-muted-foreground">{r.note}</TableCell>
                    <TableCell className="px-1 py-1.5 text-center">
                      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => remove(r)} title="Удалить из журнала"><Trash2 className="size-3.5" /></Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  )
}
