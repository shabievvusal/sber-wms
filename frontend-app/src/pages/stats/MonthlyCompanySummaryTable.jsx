import { useState } from 'react'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { Button } from '@/components/ui/button'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Spinner } from '@/components/ui/spinner'
import { fmtNum, fmtWeight, getCurrentShiftInfo } from './format'
import { RefreshCw } from 'lucide-react'

const selectClass = 'h-8 rounded-md border border-input bg-transparent px-2 text-sm'
const thCls = 'h-8 border px-2 text-center text-xs'
const tdCls = 'border px-2 py-1.5 text-center text-[13px]'

const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']

// Перенесено из оригинала (MonthlyCompanySummaryTable.jsx) дословно — 11
// колонок (первый заход по ошибке урезал до 7, потеряв СЗ хранение/КДК и
// Вес хранение/КДК — исправлено 2026-07-12), строка ИТОГО, ВЕС/Д в граммах
// (форматируется в кг при отрисовке — то же самое, что и оригинал делает
// через formatWeight, а не заранее делённое на 1000 значение).
export function MonthlyCompanySummaryTable() {
  const { dateStr: today } = getCurrentShiftInfo()
  const [month, setMonth] = useState(today.slice(0, 7))
  const [shift, setShift] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    if (!month) return
    setLoading(true)
    setError('')
    const [year, mon] = month.split('-')
    await withMinDuration(async () => {
      try {
        setData(await api.getMonthlyCompany(year, mon, shift || undefined))
      } catch (err) {
        setData(null)
        setError(err.message || 'Не удалось загрузить данные')
      }
    })
    setLoading(false)
  }

  const companies = data?.companies || []
  const totals = companies.reduce((acc, c) => {
    acc.totalTasks += c.totalTasks || 0
    acc.storageOps += c.storageOps || 0
    acc.kdkOps += c.kdkOps || 0
    acc.weightTotalGrams += c.weightTotalGrams || 0
    acc.weightStorageGrams += c.weightStorageGrams || 0
    acc.weightKdkGrams += c.weightKdkGrams || 0
    return acc
  }, { totalTasks: 0, storageOps: 0, kdkOps: 0, weightTotalGrams: 0, weightStorageGrams: 0, weightKdkGrams: 0 })

  return (
    <div className="space-y-3">
      <p className="-mt-1 text-xs text-muted-foreground">Итог СЗ, сотрудников, рабочих дней</p>
      <div className="flex flex-wrap items-center gap-2">
        <input type="month" className={selectClass} value={month} onChange={e => setMonth(e.target.value)} />
        <select className={selectClass} value={shift} onChange={e => setShift(e.target.value)}>
          <option value="">Все смены</option>
          <option value="day">День (9–21)</option>
          <option value="night">Ночь (21–9)</option>
        </select>
        <Button size="sm" variant="secondary" onClick={load} disabled={loading}>
          <RefreshCw className="size-3.5" /> {loading ? 'Загрузка...' : 'Загрузить'}
        </Button>
      </div>

      {error && <div className="text-sm text-destructive">{error}</div>}

      {loading && <Spinner label="Загрузка сводки за месяц..." />}
      {!loading && !data && !error && <div className="p-6 text-center text-sm text-muted-foreground">Выберите месяц и нажмите «Загрузить»</div>}
      {!loading && data && !companies.length && <div className="p-6 text-center text-sm text-muted-foreground">Нет данных за выбранный период</div>}
      {!loading && companies.length > 0 && (
        <>
          {data.month && (
            <div className="text-xs text-muted-foreground">{MONTH_NAMES[data.month - 1]} {data.year} · {data.daysInMonth} дней</div>
          )}
          {/* Мобильные карточки — до md (768px) */}
          <div className="divide-y rounded-md border md:hidden">
            {companies.map(c => {
              const szd = c.workDays > 0 && c.employees > 0 ? Math.round(c.totalTasks / c.employees / c.workDays) : 0
              const vezd = c.workDays > 0 && c.employees > 0 ? Math.round(c.weightTotalGrams / c.employees / c.workDays) : 0
              return (
                <div key={c.name} className="p-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-bold">{c.name}</span>
                    <div className="text-right">
                      <div className="font-bold">{fmtNum(c.totalTasks)}</div>
                      <div className="text-[11px] text-muted-foreground">{fmtWeight(c.weightTotalGrams)}</div>
                    </div>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>Сотрудников: {c.employees}</span>
                    <span>Раб. дней: {c.workDays}</span>
                    <span>СЗ/Д: {szd}</span>
                    <span>ВЕС/Д: {fmtWeight(vezd)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>СЗ хран.: {fmtNum(c.storageOps)}</span>
                    <span>СЗ КДК: {fmtNum(c.kdkOps)}</span>
                    <span>Вес хран.: {fmtWeight(c.weightStorageGrams)}</span>
                    <span>Вес КДК: {fmtWeight(c.weightKdkGrams)}</span>
                  </div>
                </div>
              )
            })}
            <div className="bg-muted/30 p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold">ИТОГО</span>
                <div className="text-right">
                  <div className="font-bold">{fmtNum(totals.totalTasks)}</div>
                  <div className="text-[11px] text-muted-foreground">{fmtWeight(totals.weightTotalGrams)}</div>
                </div>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>СЗ хран.: {fmtNum(totals.storageOps)}</span>
                <span>СЗ КДК: {fmtNum(totals.kdkOps)}</span>
                <span>Вес хран.: {fmtWeight(totals.weightStorageGrams)}</span>
                <span>Вес КДК: {fmtWeight(totals.weightKdkGrams)}</span>
              </div>
            </div>
          </div>

          {/* Десктопная таблица — от md и шире */}
          <div className="hidden overflow-hidden rounded-md border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className={thCls}>Компания</TableHead>
                  <TableHead className={thCls}>Сотрудников</TableHead>
                  <TableHead className={thCls}>Раб. дней</TableHead>
                  <TableHead className={thCls} title="Среднее задач в день на сотрудника">СЗ/Д</TableHead>
                  <TableHead className={thCls} title="Средний вес в день на сотрудника">ВЕС/Д</TableHead>
                  <TableHead className={thCls}>Итог</TableHead>
                  <TableHead className={thCls}>Вес итог</TableHead>
                  <TableHead className={thCls} title="СЗ в хранении">СЗ хранение</TableHead>
                  <TableHead className={thCls} title="СЗ в КДК">СЗ КДК</TableHead>
                  <TableHead className={thCls}>Вес хранение</TableHead>
                  <TableHead className={thCls}>Вес КДК</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {companies.map(c => {
                  const szd = c.workDays > 0 && c.employees > 0 ? Math.round(c.totalTasks / c.employees / c.workDays) : 0
                  const vezd = c.workDays > 0 && c.employees > 0 ? Math.round(c.weightTotalGrams / c.employees / c.workDays) : 0
                  return (
                    <TableRow key={c.name}>
                      <TableCell className={`${tdCls} text-left font-bold`}>{c.name}</TableCell>
                      <TableCell className={tdCls}>{c.employees}</TableCell>
                      <TableCell className={tdCls}>{c.workDays}</TableCell>
                      <TableCell className={tdCls}>{szd}</TableCell>
                      <TableCell className={tdCls}>{fmtWeight(vezd)}</TableCell>
                      <TableCell className={`${tdCls} font-bold`}>{fmtNum(c.totalTasks)}</TableCell>
                      <TableCell className={tdCls}>{fmtWeight(c.weightTotalGrams)}</TableCell>
                      <TableCell className={tdCls}>{fmtNum(c.storageOps)}</TableCell>
                      <TableCell className={tdCls}>{fmtNum(c.kdkOps)}</TableCell>
                      <TableCell className={tdCls}>{fmtWeight(c.weightStorageGrams)}</TableCell>
                      <TableCell className={tdCls}>{fmtWeight(c.weightKdkGrams)}</TableCell>
                    </TableRow>
                  )
                })}
                <TableRow className="bg-muted/30">
                  <TableCell className={`${tdCls} text-left font-bold`}>ИТОГО</TableCell>
                  <TableCell className={tdCls} /><TableCell className={tdCls} /><TableCell className={tdCls} /><TableCell className={tdCls} />
                  <TableCell className={`${tdCls} font-bold`}>{fmtNum(totals.totalTasks)}</TableCell>
                  <TableCell className={tdCls}>{fmtWeight(totals.weightTotalGrams)}</TableCell>
                  <TableCell className={tdCls}>{fmtNum(totals.storageOps)}</TableCell>
                  <TableCell className={tdCls}>{fmtNum(totals.kdkOps)}</TableCell>
                  <TableCell className={tdCls}>{fmtWeight(totals.weightStorageGrams)}</TableCell>
                  <TableCell className={tdCls}>{fmtWeight(totals.weightKdkGrams)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <div>СЗ/Д = Итог ÷ Сотрудников ÷ Раб. дней</div>
            <div>ВЕС/Д = Вес итог ÷ Сотрудников ÷ Раб. дней</div>
          </div>
        </>
      )}
    </div>
  )
}
