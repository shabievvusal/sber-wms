import { useMemo, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { SortableHead } from '@/components/ui/sortable-head'
import { fmtNum, fmtWeight, hourRangeLabel } from './format'

const headCls = 'h-8 border px-2 text-center text-xs'
const cellCls = 'border px-2 py-1.5 text-center text-[13px]'

// Перенесено из оригинала (CompanySummaryTable.jsx) — сводка по компаниям за
// выбранный день. Плотная grid-таблица (граница на каждой ячейке,
// центрированный текст) — как в оригинале, а не обычная строчная таблица.
export function CompanySummaryTable({ companySummary, filterCompany }) {
  const [showHours, setShowHours] = useState(false)
  const [sort, setSort] = useState({ key: 'totalTasks', dir: 'desc' })

  const rows = useMemo(() => {
    const list = (companySummary?.rows || []).filter(r => filterCompany === '__all__' || r.companyName === filterCompany)
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key]
      if (typeof av === 'string') return av.localeCompare(bv, 'ru') * dir
      return ((av || 0) - (bv || 0)) * dir
    })
  }, [companySummary, filterCompany, sort])

  const toggleSort = key => setSort(prev => prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' })
  const hours = companySummary?.hoursDisplay || []

  if (!rows.length) return <div className="p-6 text-center text-sm text-muted-foreground">Нет данных по компаниям</div>

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end gap-2 text-sm">
        <span className="text-xs text-muted-foreground">По часам</span>
        <Switch checked={showHours} onCheckedChange={setShowHours} />
      </div>
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead label="Компания" sortKey="companyName" sort={sort} onSort={toggleSort} className={headCls} />
              <SortableHead label="Сотрудников" sortKey="employeesCount" sort={sort} onSort={toggleSort} className={headCls} />
              <SortableHead label="СЗ/Ч" sortKey="szch" sort={sort} onSort={toggleSort} className={headCls} />
              <SortableHead label="ВЕС/Ч" sortKey="vezch" sort={sort} onSort={toggleSort} className={headCls} />
              {showHours && hours.map(h => <TableHead key={h} className={headCls} title={hourRangeLabel(h)}>{h}</TableHead>)}
              <SortableHead label="Итог" sortKey="totalTasks" sort={sort} onSort={toggleSort} className={headCls} />
              <SortableHead label="Вес итог" sortKey="weightTotalGrams" sort={sort} onSort={toggleSort} className={headCls} />
              <SortableHead label="СЗ хранение" sortKey="szStorage" sort={sort} onSort={toggleSort} className={headCls} />
              <SortableHead label="СЗ КДК" sortKey="szKdk" sort={sort} onSort={toggleSort} className={headCls} />
              <SortableHead label="Вес хранение" sortKey="weightStorageGrams" sort={sort} onSort={toggleSort} className={headCls} />
              <SortableHead label="Вес КДК" sortKey="weightKdkGrams" sort={sort} onSort={toggleSort} className={headCls} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(r => (
              <TableRow key={r.companyName}>
                <TableCell className={`${cellCls} max-w-[100px] text-left font-bold`}>{r.companyName}</TableCell>
                <TableCell className={cellCls}>{fmtNum(r.employeesCount)}</TableCell>
                <TableCell className={cellCls}>{fmtNum(r.szch)}</TableCell>
                <TableCell className={cellCls}>{fmtWeight(r.vezch || 0)}</TableCell>
                {showHours && hours.map(h => <TableCell key={h} className={cellCls}>{r.byHour?.[h] ?? ''}</TableCell>)}
                <TableCell className={`${cellCls} font-semibold`}>{fmtNum(r.totalTasks)}</TableCell>
                <TableCell className={`${cellCls} font-semibold`}>{fmtWeight(r.weightTotalGrams)}</TableCell>
                <TableCell className={cellCls}>{fmtNum(r.szStorage)}</TableCell>
                <TableCell className={cellCls}>{fmtNum(r.szKdk)}</TableCell>
                <TableCell className={cellCls}>{fmtWeight(r.weightStorageGrams)}</TableCell>
                <TableCell className={cellCls}>{fmtWeight(r.weightKdkGrams)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <div><span className="font-medium text-foreground">СЗ/Ч — среднее задач в час на сотрудника:</span> Итог ÷ Сотрудников ÷ прошедших часов</div>
        <div><span className="font-medium text-foreground">ВЕС/Ч — средний вес в час на сотрудника:</span> Вес итог ÷ Сотрудников ÷ прошедших часов</div>
        {showHours && (
          <div>Колонки по часам — сумма выполненных задач за каждый час (прошедшие + текущий). Итог — СЗ за все часы у компании.</div>
        )}
      </div>
    </div>
  )
}
