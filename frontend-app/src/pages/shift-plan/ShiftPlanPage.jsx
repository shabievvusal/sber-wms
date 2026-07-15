import { useEffect, useMemo, useState } from 'react'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { DateRangePicker } from '@/components/ui/date-picker'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Spinner } from '@/components/ui/spinner'
import { daysAgoStr, fmtNum, planStatus, todayStr } from './format'
import { RefreshCw, Users } from 'lucide-react'

const selectClass = 'h-8 rounded-md border border-input bg-transparent px-2 text-sm'

const STATUS_BORDER = {
  ok: 'border-l-4 border-l-success',
  warn: 'border-l-4 border-l-warning',
  bad: 'border-l-4 border-l-destructive',
  neutral: 'border-l-4 border-l-border',
}

// Перенесено из оригинала (frontend/app/src/pages/shift-plan/ShiftPlanPage.jsx)
// — инструмент подбора состава: по истории «СЗ» (складских заданий) за
// период считает средний результат/смену на сотрудника по выбранной
// компании, ранжирует и проверяет, закроет ли топ-N (по заявке) плановый
// показатель смены. Единственный вызов — same-origin (`getMonthlyEmployees`
// → `/api/stats/monthly-employees`), при ошибке — пустой список и текст
// ошибки. `DateRangeDropdown` оригинала (самодельный календарь) заменён на
// общий `DateRangePicker` проекта — та же техническая замена, что и в
// разделе «Комплектация».
export default function ShiftPlanPage() {
  const [companies, setCompanies] = useState([])
  const [company, setCompany] = useState('')
  const [shift, setShift] = useState('day')
  const [dateRange, setDateRange] = useState({ from: daysAgoStr(14), to: todayStr() })
  const [peopleCount, setPeopleCount] = useState('28')
  const [targetTasksPerEmployee, setTargetTasksPerEmployee] = useState('750')
  const [shiftRows, setShiftRows] = useState([])
  const [loadedRange, setLoadedRange] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.getEmployees()
      .then(data => setCompanies(data.companies || []))
      .catch(() => setCompanies([]))
  }, [])

  // react-day-picker вызывает onChange уже после первого клика по диапазону
  // (пока `to` ещё не выбран) — не завязываем доступность кнопки на `to`,
  // иначе она гаснет ровно в момент, когда пользователь начинает менять даты.
  const canLoad = Boolean(company && dateRange.from)

  const load = async () => {
    if (!canLoad) return
    const from = dateRange.from
    const to = dateRange.to || from
    setLoading(true)
    setError('')
    await withMinDuration(async () => {
      try {
        const data = await api.getMonthlyEmployees(from, to, shift)
        setShiftRows(data.rows || [])
      } catch (err) {
        setShiftRows([])
        setError(err.message || 'Не удалось загрузить данные')
      }
      setLoadedRange({ dateFrom: from, dateTo: to, shift })
    })
    setLoading(false)
  }

  const companyRates = useMemo(() => {
    const byName = new Map()
    for (const row of shiftRows) {
      const rowCompany = row.company || '—'
      if (company && rowCompany !== company) continue
      if (!byName.has(row.name)) byName.set(row.name, { name: row.name, tasksCount: 0, shiftsWorked: 0, bestShift: 0 })
      const acc = byName.get(row.name)
      acc.tasksCount += row.total
      acc.shiftsWorked += 1
      acc.bestShift = Math.max(acc.bestShift, row.total)
    }
    return [...byName.values()]
      .map(r => ({ ...r, avgPerShift: r.tasksCount / r.shiftsWorked, projectedTasks: r.tasksCount / r.shiftsWorked }))
      .sort((a, b) => b.avgPerShift - a.avgPerShift || b.tasksCount - a.tasksCount || a.name.localeCompare(b.name, 'ru'))
  }, [company, shiftRows])

  const plan = useMemo(() => {
    const requested = Math.max(0, Number(peopleCount) || 0)
    const targetPerEmployee = Math.max(0, Number(targetTasksPerEmployee) || 0)
    const totalTarget = requested * targetPerEmployee
    const selected = companyRates.slice(0, requested)
    const projected = selected.reduce((sum, row) => sum + row.projectedTasks, 0)
    const qualified = selected.filter(row => !targetPerEmployee || row.projectedTasks >= targetPerEmployee).length
    const gap = Math.max(0, totalTarget - projected)
    return { requested, targetPerEmployee, totalTarget, selected, projected, qualified, gap, status: planStatus(projected, totalTarget) }
  }, [companyRates, peopleCount, targetTasksPerEmployee])

  const loadedShiftLabel = loadedRange?.shift === 'night' ? 'Ночь' : 'День'

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">План смены</h1>
          <p className="text-sm text-muted-foreground">Рекомендованный состав по компании на основе среднего результата за смену</p>
        </div>
        <Badge variant="secondary"><Users className="size-3.5" /> {company || 'Выберите компанию'}</Badge>
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3">
        <label className="space-y-1 text-sm">
          <span className="block text-xs text-muted-foreground">Компания</span>
          <select className={selectClass} value={company} onChange={e => setCompany(e.target.value)}>
            <option value="">Выберите компанию</option>
            {companies.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="block text-xs text-muted-foreground">Смена</span>
          <select className={selectClass} value={shift} onChange={e => setShift(e.target.value)}>
            <option value="day">День</option>
            <option value="night">Ночь</option>
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="block text-xs text-muted-foreground">Период истории</span>
          <DateRangePicker from={dateRange.from} to={dateRange.to} onChange={setDateRange} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block text-xs text-muted-foreground">Заявка, чел.</span>
          <Input className="h-8 w-24" type="number" min="1" value={peopleCount} onChange={e => setPeopleCount(e.target.value)} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block text-xs text-muted-foreground">План СЗ на сотрудника</span>
          <Input className="h-8 w-28" type="number" min="0" value={targetTasksPerEmployee} onChange={e => setTargetTasksPerEmployee(e.target.value)} />
        </label>
        <Button onClick={load} disabled={loading || !canLoad}>
          <RefreshCw className="size-3.5" /> {loading ? 'Считаю...' : 'Подобрать'}
        </Button>
      </div>

      {error && <div className="text-sm text-destructive">{error}</div>}

      {loadedRange && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className={`rounded-lg border bg-card p-4 ${STATUS_BORDER[plan.status]}`}>
              <div className="text-xs text-muted-foreground">Прогноз состава</div>
              <div className="text-xl font-semibold">{fmtNum(plan.projected)}</div>
              <div className="text-xs text-muted-foreground">{loadedShiftLabel} · {loadedRange.dateFrom} – {loadedRange.dateTo}</div>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <div className="text-xs text-muted-foreground">План на смену</div>
              <div className="text-xl font-semibold">{fmtNum(plan.totalTarget)}</div>
              <div className="text-xs text-muted-foreground">{plan.requested} чел. × {plan.targetPerEmployee} СЗ</div>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <div className="text-xs text-muted-foreground">Прогноз к плану</div>
              <div className="text-xl font-semibold">{plan.gap > 0 ? `-${fmtNum(plan.gap)} СЗ` : 'Закрывается'}</div>
              <div className="text-xs text-muted-foreground">{plan.gap > 0 ? 'Не хватает СЗ до плана' : 'План смены выполняется'}</div>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <div className="text-xs text-muted-foreground">В нормативе</div>
              <div className="text-xl font-semibold">{plan.qualified} / {plan.requested}</div>
              <div className="text-xs text-muted-foreground">
                {companyRates.length ? `Со статистикой: ${companyRates.length}` : 'Нет сотрудников со статистикой'}
              </div>
            </div>
          </div>

          <div className="rounded-lg border">
            {!plan.selected.length ? (
              <div className="p-8 text-center text-sm text-muted-foreground">По выбранной компании нет сотрудников со статистикой за период</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>Роль</TableHead>
                    <TableHead>ФИО</TableHead>
                    <TableHead className="text-right">СЗ/смена</TableHead>
                    <TableHead className="text-right">Прогноз СЗ</TableHead>
                    <TableHead className="text-right">Лучший итог</TableHead>
                    <TableHead className="text-right">СЗ в истории</TableHead>
                    <TableHead className="text-right">Смен</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plan.selected.map((row, index) => (
                    <TableRow key={row.name}>
                      <TableCell>{index + 1}</TableCell>
                      <TableCell>
                        <Badge variant={row.projectedTasks >= plan.targetPerEmployee ? 'success' : 'secondary'}>
                          {row.projectedTasks >= plan.targetPerEmployee ? 'В нормативе' : 'Ниже плана'}
                        </Badge>
                      </TableCell>
                      <TableCell>{row.name}</TableCell>
                      <TableCell className="text-right">{fmtNum(row.avgPerShift, 1)}</TableCell>
                      <TableCell className="text-right">{fmtNum(row.projectedTasks, 1)}</TableCell>
                      <TableCell className="text-right">{fmtNum(row.bestShift)}</TableCell>
                      <TableCell className="text-right">{fmtNum(row.tasksCount)}</TableCell>
                      <TableCell className="text-right">{row.shiftsWorked}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </>
      )}

      {!loadedRange && !loading && (
        <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">Заполните заявку и нажмите «Подобрать»</div>
      )}
      {loading && <Spinner label="Загружаю статистику сотрудников..." />}
    </div>
  )
}
