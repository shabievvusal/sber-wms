import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { getStoredToken, getLiveMonitorViaBrowser, fetchLastCompletedForExecutor } from '@/lib/wmsFetch'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { OperationSummary } from './OperationSummary'
import { CompanyCard } from './CompanyCard'
import { SuggestionsSection } from './SuggestionsSection'
import { RollcallDialog } from './RollcallDialog'
import { EmployeeEditDialog } from './EmployeeEditDialog'
import { IDLE_WORK_MIN, REFRESH_INTERVAL_MS } from './constants'
import { formatTime, getCurrentShiftInfo, getShiftStartIso, parseLiveData } from './format'
import { ClipboardList, RefreshCw } from 'lucide-react'

// Три источника данных на каждое обновление (doRefresh), 1-в-1 с оригиналом
// по составу шагов: (1) живой снимок «кто сейчас пикает» — getLiveMonitorViaBrowser/
// getLiveMonitor (даёт «Обнаружены, но не в перекличке» и текущую задачу
// активных); (2) сводка за смену (monitorItems, api.getDateItems — same-origin
// статистика) — источник «СЗ» и первого приближения «когда последний раз
// пикал»; (3) точечный WMS-поиск на КАЖДОГО сотрудника из переклички
// (fetchLastCompletedForExecutor) — уточняет (2), т.к. сводка может ещё не
// дособраться к моменту рендера. Единственное отличие от оригинала (по
// прямому решению, см. PLAN.md) — везде связка по executorId напрямую, без
// fallback-сопоставления по ФИО (ни точного, ни нормализованного через
// personKey/normalizeFio, как в оригинале) — компания и все три источника
// данных стыкуются по executorId из реестра сотрудников/переклички, это и
// есть правильный способ, а не ФИО-эвристика оригинала.
export default function MonitorPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [employees, setEmployees] = useState([])
  const [rollcallPresent, setRollcallPresent] = useState(() => new Set())
  const [liveSnapshot, setLiveSnapshot] = useState(() => new Map())
  const [monitorItems, setMonitorItems] = useState([])
  const [lastCompletedOverrides, setLastCompletedOverrides] = useState(() => new Map())
  const [lastUpdated, setLastUpdated] = useState(null)
  const [expandedCompanies, setExpandedCompanies] = useState(() => new Set())
  const [rollcallOpen, setRollcallOpen] = useState(false)
  const [editRow, setEditRow] = useState(null)

  const shiftKeyRef = useRef(null)
  const rollcallPresentRef = useRef(new Set())
  useEffect(() => { rollcallPresentRef.current = rollcallPresent }, [rollcallPresent])

  const loadEmployees = useCallback(async () => {
    try {
      const data = await api.getEmployees()
      setEmployees(data.employees || [])
    } catch (err) {
      setEmployees([])
      setError(err.message || 'Не удалось загрузить сотрудников')
    }
  }, [])

  const loadRollcall = useCallback(async () => {
    const { dateStr, shift } = getCurrentShiftInfo()
    const currentShiftKey = `${dateStr}_${shift}`
    try {
      const data = await api.getRollcall()
      // Перекличка от другой смены — не показываем вчерашних людей.
      if (data.shiftKey && data.shiftKey !== currentShiftKey) {
        shiftKeyRef.current = null
        setRollcallPresent(new Set())
        return
      }
      shiftKeyRef.current = data.shiftKey || null
      setRollcallPresent(new Set(data.present || [])) // present — executorId[]
    } catch (err) {
      shiftKeyRef.current = currentShiftKey
      setRollcallPresent(new Set())
      setError(err.message || 'Не удалось загрузить перекличку')
    }
  }, [])

  const doRefresh = useCallback(async () => {
    await withMinDuration(async () => {
      const { dateStr, shift } = getCurrentShiftInfo()
      try {
        const res = await api.getDateItems(dateStr, { shift })
        setMonitorItems(res.items || [])
      } catch (err) {
        setMonitorItems([])
        setError(err.message || 'Не удалось загрузить данные смены')
      }
      const token = getStoredToken()
      try {
        const raw = token ? await getLiveMonitorViaBrowser(token) : await api.getLiveMonitor()
        setLiveSnapshot(parseLiveData(raw))
      } catch (err) {
        setLiveSnapshot(new Map())
        setError(err.message || 'Не удалось загрузить живой снимок')
      }

      // Точечный поиск последней завершённой задачи на каждого сотрудника из
      // переклички — тот же WMS-поиск (fetchLastCompletedForExecutor,
      // тот же эндпоинт stocks/changes/search, что и общий фетч), уточняющий
      // monitorItems/статистику по каждому executorId отдельно. В оригинале
      // это тоже есть, но связано через нормализованное ФИО и локальный
      // кэш ФИО→executorId (ловилось на совпадениях/опечатках в имени) —
      // здесь этого не нужно: executorId уже известен напрямую из переклички
      // и реестра сотрудников, без какого-либо ФИО-фоллбека.
      const present = [...rollcallPresentRef.current]
      if (token && present.length > 0) {
        const fromIso = getShiftStartIso()
        const toIso = new Date().toISOString()
        const results = await Promise.all(present.map(async executorId => {
          try {
            const res = await fetchLastCompletedForExecutor(token, executorId, fromIso, toIso)
            return [executorId, res.maxCompletedAt]
          } catch {
            return [executorId, null]
          }
        }))
        setLastCompletedOverrides(new Map(results.filter(([, ts]) => ts != null)))
      } else {
        setLastCompletedOverrides(new Map())
      }
    })
    setLastUpdated(new Date().toISOString())
  }, [])

  useEffect(() => {
    (async () => {
      setLoading(true)
      await loadEmployees()
      await loadRollcall()
      await doRefresh()
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const id = setInterval(doRefresh, REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [doRefresh])

  const emplMap = useMemo(() => {
    const map = new Map()
    for (const e of employees) if (e.executorId) map.set(e.executorId, { fio: e.fio, company: e.company })
    return map
  }, [employees])

  const { rows, groups, suggestions } = useMemo(() => {
    const now = Date.now()

    const lastCompletedAtMap = new Map()
    const szByExecutor = new Map()
    // Имя из сводки за смену — фоллбэк для отображения, когда человека нет
    // ни в живом снимке (сейчас не активен), ни в реестре сотрудников (ещё
    // не добавлен туда) — без этого такие строки показывали голый executorId
    // вместо ФИО (баг: только у подсказок был этот фоллбэк, у самих строк
    // переклички — нет).
    const executorNameFromItems = new Map()
    for (const item of monitorItems) {
      const executorId = item.executorId
      if (!executorId) continue
      szByExecutor.set(executorId, (szByExecutor.get(executorId) || 0) + 1)
      if (item.executor && !executorNameFromItems.has(executorId)) executorNameFromItems.set(executorId, item.executor)
      if (!item.completedAt) continue
      const ts = new Date(item.completedAt).getTime()
      if (!lastCompletedAtMap.has(executorId) || lastCompletedAtMap.get(executorId) < ts) lastCompletedAtMap.set(executorId, ts)
    }
    // Точечный WMS-поиск (fetchLastCompletedForExecutor) считается точнее
    // сводки за смену (monitorItems может не успеть дособраться/дообновиться
    // к моменту рендера) — там, где он реально отработал, перекрывает значение.
    for (const [executorId, ts] of lastCompletedOverrides) {
      if (ts != null) lastCompletedAtMap.set(executorId, ts)
    }

    const computedRows = []
    for (const executorId of rollcallPresent) {
      const liveEntry = liveSnapshot.get(executorId)
      const isActive = !!liveEntry
      const empl = emplMap.get(executorId)
      const company = empl?.company || '—'
      const lastTs = lastCompletedAtMap.get(executorId) ?? null
      const minutesSinceLastTask = lastTs != null ? (now - lastTs) / 60000 : null
      const lastTaskMs = lastTs != null ? now - lastTs : null
      const inWorkByTask = minutesSinceLastTask != null && minutesSinceLastTask <= IDLE_WORK_MIN
      const taskDurationMs = (isActive && liveEntry?.startedAt) ? now - new Date(liveEntry.startedAt).getTime() : null
      const displayFio = liveEntry?.displayFio || empl?.fio || executorNameFromItems.get(executorId) || executorId

      computedRows.push({
        executorId, displayFio, company, isActive,
        sz: szByExecutor.get(executorId) || 0,
        taskType: liveEntry?.taskType || null,
        taskDurationMs, lastTaskMs, minutesSinceLastTask, inWorkByTask,
      })
    }

    const byCompany = new Map()
    for (const row of computedRows) {
      if (!byCompany.has(row.company)) byCompany.set(row.company, { company: row.company, rows: [], active: 0, inactive: 0 })
      const g = byCompany.get(row.company)
      g.rows.push(row)
      row.inWorkByTask ? g.active++ : g.inactive++
    }
    const computedGroups = [...byCompany.values()].sort((a, b) => b.inactive - a.inactive || a.company.localeCompare(b.company, 'ru'))
    for (const g of computedGroups) {
      g.rows.sort((a, b) => {
        if (a.minutesSinceLastTask != null && b.minutesSinceLastTask != null && a.minutesSinceLastTask !== b.minutesSinceLastTask) {
          return b.minutesSinceLastTask - a.minutesSinceLastTask
        }
        if (a.minutesSinceLastTask != null && b.minutesSinceLastTask == null) return -1
        if (a.minutesSinceLastTask == null && b.minutesSinceLastTask != null) return 1
        return 0
      })
    }

    // Два источника подсказок «на смене, но не в перекличке» — 1-в-1 с
    // оригиналом (там liveSnapshot + executorSource из monitorItems, здесь
    // то же самое, но по executorId, не по ФИО): (1) кто сейчас реально
    // активен (liveSnapshot); (2) кто засветился в сводке за смену
    // (monitorItems), даже если сейчас уже не пикает — ушёл на перерыв,
    // закончил задачу и т.д. Без второго источника люди, поработавшие
    // раньше в смене и сейчас неактивные, вообще никогда не попадали бы в
    // подсказки — ровно так терялась разница между «сотрудников в
    // статистике» (реальная работа за смену) и «сотрудников в мониторинге»
    // (перекличка).
    const suggestionsOut = []
    const seenSuggested = new Set()
    for (const [executorId, entry] of liveSnapshot) {
      if (rollcallPresent.has(executorId) || seenSuggested.has(executorId)) continue
      seenSuggested.add(executorId)
      suggestionsOut.push({ executorId, displayFio: entry.displayFio, company: emplMap.get(executorId)?.company || '—', taskType: entry.taskType })
    }
    for (const item of monitorItems) {
      const executorId = item.executorId
      if (!executorId || rollcallPresent.has(executorId) || seenSuggested.has(executorId)) continue
      seenSuggested.add(executorId)
      const empl = emplMap.get(executorId)
      suggestionsOut.push({ executorId, displayFio: empl?.fio || executorNameFromItems.get(executorId) || executorId, company: empl?.company || '—', taskType: null })
    }

    return { rows: computedRows, groups: computedGroups, suggestions: suggestionsOut }
  }, [rollcallPresent, liveSnapshot, monitorItems, emplMap, lastCompletedOverrides])

  const persistRollcall = async present => {
    const { dateStr, shift } = getCurrentShiftInfo()
    const shiftKey = shiftKeyRef.current || `${dateStr}_${shift}`
    shiftKeyRef.current = shiftKey
    try { await api.putRollcall(shiftKey, present) } catch (err) { toast.error(err.message || 'Не удалось сохранить перекличку') }
  }

  const handleRollcallSave = async present => {
    setRollcallPresent(new Set(present))
    setRollcallOpen(false)
    await persistRollcall(present)
    toast.success('Перекличка сохранена')
    doRefresh()
  }

  const handleAddSuggestion = async executorId => {
    const present = [...rollcallPresentRef.current]
    if (!present.includes(executorId)) present.push(executorId)
    setRollcallPresent(new Set(present))
    await persistRollcall(present)
    doRefresh()
  }

  const handleAddAllSuggestions = async () => {
    const present = [...rollcallPresentRef.current]
    for (const s of suggestions) if (!present.includes(s.executorId)) present.push(s.executorId)
    setRollcallPresent(new Set(present))
    await persistRollcall(present)
    doRefresh()
  }

  const handleEmployeeSave = async ({ onShift }) => {
    const row = editRow
    setEditRow(null)
    if (!row) return

    if (!onShift) {
      const present = [...rollcallPresentRef.current].filter(p => p !== row.executorId)
      setRollcallPresent(new Set(present))
      await persistRollcall(present)
    }
    doRefresh()
  }

  const handleToggleCompany = company => setExpandedCompanies(prev => {
    const next = new Set(prev)
    next.has(company) ? next.delete(company) : next.add(company)
    return next
  })

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-[1200px] p-6">
        <Spinner label="Загрузка мониторинга..." />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Мониторинг смены</h1>
        <p className="text-sm text-muted-foreground">Перекличка и живая активность сотрудников на складе</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-3">
        <div className="flex items-center gap-3">
          <Button onClick={() => setRollcallOpen(true)}><ClipboardList className="size-4" /> Перекличка</Button>
          {rollcallPresent.size > 0 && <span className="text-sm text-muted-foreground">{rollcallPresent.size} чел. на смене</span>}
        </div>
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={doRefresh}><RefreshCw className="size-3.5" /> Обновить</Button>
          {lastUpdated && <span className="text-sm text-muted-foreground">Обновлено: {formatTime(lastUpdated)}</span>}
        </div>
      </div>

      <SuggestionsSection suggestions={suggestions} onAdd={handleAddSuggestion} onAddAll={handleAddAllSuggestions} />

      {rollcallPresent.size === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          Перекличка не проведена.<br />
          Нажмите <strong className="text-foreground">«Перекличка»</strong>, чтобы отметить сотрудников на смене.
        </div>
      ) : (
        <>
          <OperationSummary rows={rows} />
          <div className="space-y-3">
            {groups.map(g => (
              <CompanyCard
                key={g.company}
                g={g}
                isExpanded={expandedCompanies.has(g.company)}
                onToggle={() => handleToggleCompany(g.company)}
                onRowClick={r => setEditRow(r)}
              />
            ))}
          </div>
        </>
      )}

      {rollcallOpen && (
        <RollcallDialog
          employees={employees}
          present={rollcallPresent}
          onOpenChange={setRollcallOpen}
          onSave={handleRollcallSave}
        />
      )}
      {editRow && (
        <EmployeeEditDialog
          row={{ ...editRow, isPresent: true }}
          onOpenChange={open => !open && setEditRow(null)}
          onSave={handleEmployeeSave}
        />
      )}
    </div>
  )
}
