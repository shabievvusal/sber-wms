import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { DatePicker, DateRangePicker } from '@/components/ui/date-picker'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Spinner } from '@/components/ui/spinner'
import { daysAgoStr, fmtNum, todayStr } from './format'
import { loadActConstants, loadCompanyFullNames } from './actConstants'
import { buildActWorkbook } from './actTemplate'
import { RefreshCw, Users, FileDown, ArrowRight } from 'lucide-react'

const selectClass = 'h-8 rounded-md border border-input bg-transparent px-2 text-sm'

// План смены на основе заявки (2026-07-28): вместо подбора состава для ОДНОЙ
// компании (как было) — заявка теперь по каждой аутстафф-компании отдельно
// (сколько человек нужно с каждой), подбор идёт по каждой своим топ-N по
// среднему СЗ/смену, и если кто-то из выбранных не дотягивает до целевого
// норматива — система предлагает (не подставляет молча) замену человеком
// из другой компании, который норматив выполняет и не занят в чужой
// заявке. Итоговый состав → Акт учёта времени на каждую компанию (см.
// actTemplate.js), все акты — в одном ZIP.
export default function ShiftPlanPage() {
  const [companies, setCompanies] = useState([])
  const [requested, setRequested] = useState({}) // { [company]: string (числовой инпут) }
  const [shift, setShift] = useState('day')
  const [planDate, setPlanDate] = useState(todayStr())
  const [dateRange, setDateRange] = useState({ from: daysAgoStr(14), to: todayStr() })
  const [targetTasksPerEmployee, setTargetTasksPerEmployee] = useState('750')
  const [shiftRows, setShiftRows] = useState([])
  const [loadedRange, setLoadedRange] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [accepted, setAccepted] = useState(() => new Set()) // "company#index"
  const [generating, setGenerating] = useState(false)

  // Калькулятор потребности в сотрудниках (2026-07-28) — только на ДЕНЬ (для
  // ночи известен уже готовый общий выход, отдельно не считаем — «Ночь» ниже
  // нужна только чтобы вычесть её из суток и получить день). Штат — свои
  // сотрудники, в акты не попадают, вычитаются из потребности. Грузчики и
  // работники заморозки — это НЕ добавка сверху, а внутреннее распределение
  // одного и того же доступного по весу пула: если по весу доступно 88
  // человек и 8 из них — грузчики, значит комплектовщиков заказываем
  // 88 − 8 = 80, а не 88 + 8.
  const [weights, setWeights] = useState({ kdk: '', hs: '', hsh: '', zamorozka: '' })
  const [tsu, setTsu] = useState('1200')
  const [nightTotalOutput, setNightTotalOutput] = useState('')
  const [dayOwnStaff, setDayOwnStaff] = useState('')
  const [extraLoaders, setExtraLoaders] = useState('')
  const [extraFreezerWorkers, setExtraFreezerWorkers] = useState('')

  useEffect(() => {
    api.getEmployees()
      .then(data => setCompanies(data.companies || []))
      .catch(() => setCompanies([]))
  }, [])

  const canLoad = Boolean(dateRange.from)

  const load = async () => {
    if (!canLoad) return
    const from = dateRange.from
    const to = dateRange.to || from
    setLoading(true)
    setError('')
    setAccepted(new Set())
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

  // Ранжирование по КАЖДОЙ компании отдельно — та же формула среднего
  // СЗ/смену, что была раньше только для одной выбранной компании, просто
  // без фильтра и сгруппированная по company.
  const ratesByCompany = useMemo(() => {
    const byKey = new Map()
    for (const row of shiftRows) {
      const rowCompany = row.company || '—'
      const key = `${rowCompany}||${row.name}`
      if (!byKey.has(key)) byKey.set(key, { name: row.name, company: rowCompany, tasksCount: 0, shiftsWorked: 0, bestShift: 0 })
      const acc = byKey.get(key)
      acc.tasksCount += row.total
      acc.shiftsWorked += 1
      acc.bestShift = Math.max(acc.bestShift, row.total)
    }
    const all = [...byKey.values()].map(r => ({ ...r, avgPerShift: r.tasksCount / r.shiftsWorked }))
    const grouped = new Map()
    for (const r of all) {
      if (!grouped.has(r.company)) grouped.set(r.company, [])
      grouped.get(r.company).push(r)
    }
    for (const arr of grouped.values()) {
      arr.sort((a, b) => b.avgPerShift - a.avgPerShift || b.tasksCount - a.tasksCount || a.name.localeCompare(b.name, 'ru'))
    }
    return grouped
  }, [shiftRows])

  // Подбор + предложения замены — чистое вычисление плана. Пересчитывается
  // при изменении заявки/цели, не требует повторного похода в API.
  const plan = useMemo(() => {
    const target = Math.max(0, Number(targetTasksPerEmployee) || 0)
    const slotsByCompany = new Map() // company -> [{ name, avgPerShift, qualified, suggestion }]
    const usedKeys = new Set()

    for (const company of companies) {
      const need = Math.max(0, Math.floor(Number(requested[company]) || 0))
      if (need <= 0) continue
      const rates = ratesByCompany.get(company) || []
      const selected = rates.slice(0, need)
      slotsByCompany.set(company, selected.map(r => {
        usedKeys.add(`${r.company}||${r.name}`)
        return { name: r.name, avgPerShift: r.avgPerShift, qualified: !target || r.avgPerShift >= target, suggestion: null }
      }))
    }

    // Пул кандидатов на замену: ТОЛЬКО из компаний, которые есть в заявке
    // (пользователь сам выбирает, с какими компаниями работает на эту смену —
    // предлагать сотрудников из компаний вне заявки не нужно), в нормативе,
    // ещё никем не занят.
    const requestedCompanies = new Set(slotsByCompany.keys())
    const pool = [...ratesByCompany.entries()]
      .filter(([company]) => requestedCompanies.has(company))
      .flatMap(([, rates]) => rates)
      .filter(r => !usedKeys.has(`${r.company}||${r.name}`))
      .filter(r => !target || r.avgPerShift >= target)
      .sort((a, b) => b.avgPerShift - a.avgPerShift)
    const poolUsed = new Set()

    for (const [company, slots] of slotsByCompany) {
      slots.forEach(slot => {
        if (slot.qualified) return
        const candidate = pool.find(c => c.company !== company && !poolUsed.has(`${c.company}||${c.name}`))
        if (candidate) {
          poolUsed.add(`${candidate.company}||${candidate.name}`)
          slot.suggestion = { name: candidate.name, company: candidate.company, avgPerShift: candidate.avgPerShift }
        }
      })
    }

    // Итоговый состав по компаниям — с учётом принятых замен (человек идёт
    // в акт своей ФАКТИЧЕСКОЙ компании, не той, что его запросила).
    const finalByCompany = new Map()
    const pushFinal = (company, name) => {
      if (!finalByCompany.has(company)) finalByCompany.set(company, [])
      finalByCompany.get(company).push(name)
    }
    for (const [company, slots] of slotsByCompany) {
      slots.forEach((slot, index) => {
        const isAccepted = accepted.has(`${company}#${index}`)
        if (isAccepted && slot.suggestion) pushFinal(slot.suggestion.company, slot.suggestion.name)
        else pushFinal(company, slot.name)
      })
    }

    return { slotsByCompany, finalByCompany, target }
  }, [companies, requested, ratesByCompany, accepted, targetTasksPerEmployee])

  // Потребность в операционные сутки = общий вес / ЦУ. Ночь (уже известный
  // общий выход) вычитается из суток, чтобы получить день. День дальше
  // уменьшается на свой дневной штат — остаток = сколько аутсорса доступно
  // по весу на день. Грузчики/заморозка — это распределение ВНУТРИ этого же
  // пула (не добавка сверху): сколько из доступных по весу людей уходит на
  // другие роли, остаток — комплектовщики к заказу.
  const calc = useMemo(() => {
    const totalWeight = ['kdk', 'hs', 'hsh', 'zamorozka'].reduce((s, k) => s + (Number(weights[k]) || 0), 0)
    const tsuNum = Number(tsu) || 0
    const totalNeed = tsuNum > 0 ? totalWeight / tsuNum : 0
    const night = Math.max(0, Number(nightTotalOutput) || 0)
    const dayTotal = Math.max(0, totalNeed - night)
    const dayOutsourcePool = Math.max(0, dayTotal - (Number(dayOwnStaff) || 0))
    const otherRoles = Math.max(0, Number(extraLoaders) || 0) + Math.max(0, Number(extraFreezerWorkers) || 0)
    const dayOutsourcePickers = Math.max(0, dayOutsourcePool - otherRoles)
    return { totalWeight, totalNeed, night, dayTotal, dayOutsourcePool, otherRoles, dayOutsourcePickers }
  }, [weights, tsu, nightTotalOutput, dayOwnStaff, extraLoaders, extraFreezerWorkers])

  const totalRequested = Object.values(requested).reduce((s, v) => s + (Math.max(0, Math.floor(Number(v) || 0)) || 0), 0)
  const totalFinal = [...plan.finalByCompany.values()].reduce((s, arr) => s + arr.length, 0)
  const pendingSuggestions = [...plan.slotsByCompany.entries()]
    .flatMap(([company, slots]) => slots.map((s, i) => ({ company, index: i, slot: s })))
    .filter(x => !x.slot.qualified && x.slot.suggestion)
  const acceptedCount = pendingSuggestions.filter(x => accepted.has(`${x.company}#${x.index}`)).length

  const toggleAccept = (company, index) => setAccepted(prev => {
    const key = `${company}#${index}`
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })

  const handleGenerateActs = async () => {
    if (totalFinal === 0) { toast.info('Нет ни одного человека в итоговом составе'); return }
    setGenerating(true)
    try {
      const ExcelJS = (await import('exceljs')).default
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()
      const constants = loadActConstants()
      const fullNames = loadCompanyFullNames()
      // Date.UTC, а не `new Date(iso)` — иначе в часовых поясах восточнее UTC
      // (Москва, UTC+3) полночь по местному времени уходит в предыдущий день
      // по UTC, а ExcelJS сериализует дату в xlsx по UTC-компонентам: дата в
      // акте съезжала бы на день назад ровно у пользователей из РФ.
      const [y, m, d] = planDate.split('-').map(Number)
      const dateObj = new Date(Date.UTC(y, m - 1, d))

      for (const [company, names] of plan.finalByCompany) {
        if (!names.length) continue
        const wb = buildActWorkbook(ExcelJS, {
          customerName: constants.customerName,
          contractorFullName: fullNames[company]?.trim() || company,
          warehouseAddress: constants.warehouseAddress,
          warehouseType: constants.warehouseType,
          warehouseCategory: constants.warehouseCategory,
          date: dateObj,
          shift,
          employees: names.map(name => ({ name })),
        })
        const buf = await wb.xlsx.writeBuffer()
        zip.file(`Акт ${company} ${planDate}.xlsx`, buf)
      }

      const blob = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Акты_${planDate}_${shift === 'night' ? 'ночь' : 'день'}.zip`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success(`Сформировано актов: ${plan.finalByCompany.size}`)
    } catch (err) {
      toast.error('Ошибка формирования актов: ' + err.message)
    } finally {
      setGenerating(false)
    }
  }

  const loadedShiftLabel = loadedRange?.shift === 'night' ? 'Ночь' : 'День'

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">План смены</h1>
          <p className="text-sm text-muted-foreground">Заявка по каждой компании — подбор состава по истории, с предложением замен из других компаний</p>
        </div>
        <Badge variant="secondary"><Users className="size-3.5" /> Заявка: {totalRequested} чел.</Badge>
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3">
        <label className="space-y-1 text-sm">
          <span className="block text-xs text-muted-foreground">Дата смены</span>
          <DatePicker value={planDate} onChange={e => setPlanDate(e.target.value)} className="h-8 w-36" />
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
          <span className="block text-xs text-muted-foreground">План СЗ на сотрудника</span>
          <Input className="h-8 w-28" type="number" min="0" value={targetTasksPerEmployee} onChange={e => setTargetTasksPerEmployee(e.target.value)} />
        </label>
        <Button onClick={load} disabled={loading || !canLoad}>
          <RefreshCw className="size-3.5" /> {loading ? 'Считаю...' : 'Подобрать'}
        </Button>
      </div>

      <div className="rounded-lg border bg-card p-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Калькулятор потребности в сотрудниках (только аутсорс, штат не заказывается)
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">КДК, кг</span>
            <Input type="number" min="0" className="h-8" value={weights.kdk} onChange={e => setWeights(w => ({ ...w, kdk: e.target.value }))} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">ХС, кг</span>
            <Input type="number" min="0" className="h-8" value={weights.hs} onChange={e => setWeights(w => ({ ...w, hs: e.target.value }))} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">ХСХ, кг</span>
            <Input type="number" min="0" className="h-8" value={weights.hsh} onChange={e => setWeights(w => ({ ...w, hsh: e.target.value }))} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">Заморозка, кг</span>
            <Input type="number" min="0" className="h-8" value={weights.zamorozka} onChange={e => setWeights(w => ({ ...w, zamorozka: e.target.value }))} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">ЦУ (норматив, кг/чел.)</span>
            <Input type="number" min="1" className="h-8" value={tsu} onChange={e => setTsu(e.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">Ночь — общий выход</span>
            <Input type="number" min="0" className="h-8" value={nightTotalOutput} onChange={e => setNightTotalOutput(e.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">Свой штат, день</span>
            <Input type="number" min="0" className="h-8" value={dayOwnStaff} onChange={e => setDayOwnStaff(e.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">Грузчики, чел. (из доступных по весу)</span>
            <Input type="number" min="0" className="h-8" value={extraLoaders} onChange={e => setExtraLoaders(e.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">Заморозка, чел. (из доступных по весу)</span>
            <Input type="number" min="0" className="h-8" value={extraFreezerWorkers} onChange={e => setExtraFreezerWorkers(e.target.value)} />
          </label>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3 rounded-md bg-muted/30 p-3 text-sm sm:grid-cols-4">
          <div>
            <div className="text-xs text-muted-foreground">Потребность в сутки</div>
            <div className="font-semibold">{fmtNum(calc.totalNeed, 1)} чел.</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">День, всего (сутки − ночь)</div>
            <div className="font-semibold">{fmtNum(calc.dayTotal, 1)} чел.</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Доступно аутсорса по весу (день)</div>
            <div className="font-semibold">{fmtNum(calc.dayOutsourcePool, 1)} чел.</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Комплектовщиков к заказу (минус грузчики/заморозка)</div>
            <div className="text-base font-semibold text-primary">{fmtNum(calc.dayOutsourcePickers, 1)} чел.</div>
          </div>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          {fmtNum(calc.dayOutsourcePool, 1)} доступно по весу − {fmtNum(calc.otherRoles, 1)} грузчики/заморозка = {fmtNum(calc.dayOutsourcePickers, 1)} комплектовщиков.
          {' '}Указано по компаниям ниже: <strong>{totalRequested}</strong> из <strong>{fmtNum(calc.dayOutsourcePickers, 1)}</strong> — распределите остаток вручную.
        </div>
      </div>

      <div className="rounded-lg border bg-card p-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Заявка по компаниям</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {companies.map(company => (
            <label key={company} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-sm">
              <span className="truncate" title={company}>{company}</span>
              <Input
                type="number" min="0" className="h-7 w-16 shrink-0"
                value={requested[company] ?? ''}
                onChange={e => setRequested(prev => ({ ...prev, [company]: e.target.value }))}
              />
            </label>
          ))}
          {companies.length === 0 && <div className="text-sm text-muted-foreground">Нет компаний — добавьте сотрудников в Настройках</div>}
        </div>
      </div>

      {error && <div className="text-sm text-destructive">{error}</div>}

      {loadedRange && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border bg-card p-4">
              <div className="text-xs text-muted-foreground">Запрошено</div>
              <div className="text-xl font-semibold">{totalRequested} чел.</div>
              <div className="text-xs text-muted-foreground">{loadedShiftLabel} · {loadedRange.dateFrom} – {loadedRange.dateTo}</div>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <div className="text-xs text-muted-foreground">Итоговый состав</div>
              <div className="text-xl font-semibold">{totalFinal} чел.</div>
              <div className="text-xs text-muted-foreground">{plan.finalByCompany.size} компани{plan.finalByCompany.size === 1 ? 'я' : 'и'}</div>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <div className="text-xs text-muted-foreground">Предложено замен</div>
              <div className="text-xl font-semibold">{pendingSuggestions.length}</div>
              <div className="text-xs text-muted-foreground">не в нормативе, есть кем заменить</div>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <div className="text-xs text-muted-foreground">Принято замен</div>
              <div className="text-xl font-semibold">{acceptedCount} / {pendingSuggestions.length}</div>
              <div className="text-xs text-muted-foreground">отметьте «Заменить» в таблице ниже</div>
            </div>
          </div>

          <div className="space-y-4">
            {[...plan.slotsByCompany.entries()].map(([company, slots]) => (
              <div key={company} className="rounded-lg border">
                <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2">
                  <div className="font-medium">{company}</div>
                  <div className="text-xs text-muted-foreground">Запрошено {slots.length} · В итоговом составе {plan.finalByCompany.get(company)?.length || 0}</div>
                </div>
                {slots.length === 0 ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">Нет сотрудников со статистикой за период</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">#</TableHead>
                        <TableHead>Статус</TableHead>
                        <TableHead>Ф.И.О.</TableHead>
                        <TableHead className="text-right">СЗ/смена</TableHead>
                        <TableHead>Замена</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {slots.map((slot, index) => {
                        const key = `${company}#${index}`
                        const isAccepted = accepted.has(key)
                        return (
                          <TableRow key={index}>
                            <TableCell>{index + 1}</TableCell>
                            <TableCell>
                              <Badge variant={slot.qualified ? 'success' : 'warning'}>
                                {slot.qualified ? 'В нормативе' : 'Ниже плана'}
                              </Badge>
                            </TableCell>
                            <TableCell className={isAccepted ? 'text-muted-foreground line-through' : ''}>{slot.name}</TableCell>
                            <TableCell className="text-right">{fmtNum(slot.avgPerShift, 1)}</TableCell>
                            <TableCell>
                              {!slot.qualified && (
                                slot.suggestion ? (
                                  <div className="flex items-center gap-2 text-sm">
                                    <Checkbox checked={isAccepted} onCheckedChange={() => toggleAccept(company, index)} />
                                    <ArrowRight size={13} className="text-muted-foreground" />
                                    <span className="font-medium">{slot.suggestion.name}</span>
                                    <span className="text-xs text-muted-foreground">
                                      ({slot.suggestion.company}, {fmtNum(slot.suggestion.avgPerShift, 1)} СЗ/смену)
                                    </span>
                                  </div>
                                ) : (
                                  <span className="text-xs text-muted-foreground">Нет свободной замены в нормативе</span>
                                )
                              )}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                )}
              </div>
            ))}
            {plan.slotsByCompany.size === 0 && (
              <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">Заполните заявку по компаниям выше</div>
            )}
          </div>

          <div className="flex justify-end">
            <Button onClick={handleGenerateActs} disabled={generating || totalFinal === 0}>
              <FileDown className="size-3.5" /> {generating ? 'Формирую...' : `Сформировать акты (${plan.finalByCompany.size})`}
            </Button>
          </div>
        </>
      )}

      {!loadedRange && !loading && (
        <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">Заполните заявку по компаниям и нажмите «Подобрать»</div>
      )}
      {loading && <Spinner label="Загружаю статистику сотрудников..." />}
    </div>
  )
}
