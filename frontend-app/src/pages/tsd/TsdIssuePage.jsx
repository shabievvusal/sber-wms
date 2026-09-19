import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as api from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { SortableHead } from '@/components/ui/sortable-head'
import { Spinner } from '@/components/ui/spinner'
import QrCodeSvg from '@/components/QrCodeSvg'
import { DateRangePicker } from '@/components/ui/date-picker'
import {
  dayEndIso, dayStartIso, dayStr, employeeCode, extractEmployeeCode, formatDateTime,
  normalizeScannerCode, shortFio,
} from './format'
import { ScanLine, Printer, RotateCcw, CheckSquare, Square, RefreshCw } from 'lucide-react'

// Перенесено из оригинала (frontend/app/src/pages/tsd/TsdIssuePage.jsx) — кио­ск
// сканирования: держит и отдаёт сотрудникам физические ТСД (сканеры штрихкодов
// склада). Все 3 родных эндпоинта (getTsdAssignments/assignTsd/
// returnTsdByBarcode) — same-origin, требуют USE_PG=true на бэкенде (backend/
// tsd-pg.js) — без Postgres backend отвечает 503. Раздел действительно в
// NAV_ITEMS оригинала (первоклассный пункт меню, не скрытый кио­ск-роут вроде
// ReceivePage) — см. PLAN.md.
//
// Список сотрудников — ДВА источника (добавлено 2026-07-15, запрос
// пользователя): (1) api.getEmployees() — обычный реестр, ключ executorId,
// участвует в статистике/мониторинге; (2) api.getTsdManualEmployees() —
// сотрудники БЕЗ executorId (не встречаются в статистике WMS), заводятся
// вручную в Настройках (TsdSettingsCard.jsx → TsdManualEmployeesCard)
// исключительно для этой страницы. Оба источника сливаются в один общий
// `employees` с одинаковой формой {executorId, fio, company} — у второго
// источника `executorId` это синтетический id ("manual-xxx"), не настоящий
// WMS UUID, но для QR/печати/назначения ТСД это не важно (employeeCode()
// просто кодирует его как есть, tsd_assignments не имеет FK на employees).
// Эти сотрудники нигде БОЛЬШЕ не появляются — ни в статистике, ни в
// мониторинге, ни в общем реестре Настроек → Сотрудники.

const selectClass = 'h-8 rounded-md border border-input bg-transparent px-2 text-sm'

const TSD_PRINT_CSS = `
.tsd-print-portal { display: none; }
@media print {
  body.tsd-printing #root { display: none !important; }
  body.tsd-printing .tsd-print-portal { display: block !important; }
  @page { size: 100mm 75mm; margin: 0; }
}
.tsd-print-label {
  width: 100mm; height: 75mm; box-sizing: border-box; padding: 6mm;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4mm;
  page-break-after: page; break-after: page;
}
.tsd-print-label:last-child { page-break-after: auto; break-after: auto; }
.tsd-print-qr { width: 45mm; height: 45mm; }
.tsd-print-company { font-size: 11pt; font-weight: 600; text-align: center; }
.tsd-print-name { font-size: 13pt; font-weight: 700; text-align: center; }
`

function assignmentsToEmployeeMap(list) {
  const map = {}
  for (const rec of list || []) {
    if (!rec.executorId) continue
    if (!map[rec.executorId]) map[rec.executorId] = []
    map[rec.executorId].push(rec)
  }
  return map
}

function assignmentsToTsdMap(list) {
  const map = {}
  for (const rec of list || []) if (rec.tsd) map[rec.tsd] = rec
  return map
}

function printQr() {
  const body = document.body
  const cleanup = () => body.classList.remove('tsd-printing')
  body.classList.add('tsd-printing')
  window.addEventListener('afterprint', cleanup, { once: true })
  window.print()
  window.setTimeout(cleanup, 1500)
}

function schedulePrint() {
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => printQr()))
}

export default function TsdIssuePage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [employees, setEmployees] = useState([])
  const [assignments, setAssignments] = useState([])
  const [tsdSettings, setTsdSettings] = useState({ totalCount: 0 })
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [company, setCompany] = useState('')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [scanValue, setScanValue] = useState('')
  const [pendingTsd, setPendingTsd] = useState(null)
  const [message, setMessage] = useState('')
  const [printItems, setPrintItems] = useState([])
  const [printRequested, setPrintRequested] = useState(false)
  const [activeTab, setActiveTab] = useState('issue')
  const [sort, setSort] = useState({ key: 'company', dir: 'asc' })
  const [scanFocused, setScanFocused] = useState(false)
  const [history, setHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyFrom, setHistoryFrom] = useState(() => dayStr(-6))
  const [historyTo, setHistoryTo] = useState(() => dayStr(0))
  const [historyType, setHistoryType] = useState('all')
  const [historyQuery, setHistoryQuery] = useState('')
  const scanRef = useRef(null)

  const load = useCallback(async ({ clearMessage = false } = {}) => {
    try {
      const [employeesData, manualData, assignmentsData] = await Promise.all([
        api.getEmployees(),
        api.getTsdManualEmployees().catch(() => ({ employees: [] })),
        api.getTsdAssignments(),
      ])
      const manualAsEmployees = (manualData?.employees || []).map(m => ({ executorId: m.id, fio: m.fio, company: m.company || '' }))
      setEmployees([...(employeesData?.employees || []).filter(e => e.executorId), ...manualAsEmployees])
      setAssignments(assignmentsData?.assignments || [])
      setTsdSettings(assignmentsData?.settings || { totalCount: 0 })
      setError('')
    } catch (err) {
      setError(err.message || 'Не удалось загрузить данные ТСД')
    }
    if (clearMessage) setMessage('')
  }, [])

  useEffect(() => {
    (async () => { setLoading(true); await load({ clearMessage: true }); setLoading(false) })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => { load().catch(() => {}) }, 10_000)
    const refreshOnFocus = () => { if (document.visibilityState === 'visible') load().catch(() => {}) }
    document.addEventListener('visibilitychange', refreshOnFocus)
    window.addEventListener('focus', refreshOnFocus)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshOnFocus)
      window.removeEventListener('focus', refreshOnFocus)
    }
  }, [load])

  // ── Удержание фокуса на поле сканера ──────────────────────────────────────
  // Раньше поле было размером 1px с opacity:0, и фокус терялся от любого
  // клика мимо карточки, переключения вкладки или сворачивания окна — чтобы
  // отсканировать, приходилось каждый раз вслепую прокликивать карточку.
  // Теперь поле видимое, а фокус возвращается сам: (1) после blur, если он
  // ушёл «в никуда» (на body), (2) по таймеру — после закрытия диалогов и
  // алертов, (3) на первом же символе, напечатанном мимо поля: сканер бьёт
  // по клавиатуре, символ дописываем руками, поэтому он не теряется.
  const focusScan = useCallback(() => {
    const el = scanRef.current
    if (!el || el === document.activeElement) return
    el.focus()
  }, [])

  useEffect(() => {
    if (activeTab !== 'issue') return
    focusScan()
  }, [activeTab, pendingTsd, focusScan])

  useEffect(() => {
    if (activeTab !== 'issue') return

    // Фокус не отбираем, если пользователь намеренно ушёл в другой контрол
    // (фильтр, кнопка) — только если он повис на body после клика по пустому.
    const idle = () => !document.activeElement || document.activeElement === document.body
    const timer = window.setInterval(() => { if (idle()) focusScan() }, 1500)

    const onKeyDown = e => {
      const el = scanRef.current
      if (!el || document.activeElement === el) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const target = document.activeElement
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      if (e.key.length === 1) {
        e.preventDefault()
        setScanValue(prev => prev + e.key)
        el.focus()
      } else if (e.key === 'Enter') {
        el.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [activeTab, focusScan])

  const handleScanBlur = useCallback(() => {
    setScanFocused(false)
    window.setTimeout(() => {
      const target = document.activeElement
      if (target && target !== document.body && target !== scanRef.current) return
      focusScan()
    }, 0)
  }, [focusScan])

  useEffect(() => {
    if (!printRequested || !printItems.length) return
    schedulePrint()
    setPrintRequested(false)
  }, [printItems, printRequested])

  const employeesById = useMemo(() => {
    const map = new Map()
    for (const emp of employees) map.set(emp.executorId, emp)
    return map
  }, [employees])

  const companies = useMemo(
    () => [...new Set(employees.map(e => e.company).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')),
    [employees]
  )

  const assignmentsByEmployee = useMemo(() => assignmentsToEmployeeMap(assignments), [assignments])
  const assignmentsByTsd = useMemo(() => assignmentsToTsdMap(assignments), [assignments])
  const issuedCount = assignments.length
  const totalTsdCount = Number(tsdSettings.totalCount) || 0
  const remainingTsdCount = Math.max(0, totalTsdCount - issuedCount)

  const getEmployeeStatus = useCallback(
    emp => (assignmentsByEmployee[emp.executorId]?.length ? 'not_returned' : 'returned'),
    [assignmentsByEmployee]
  )

  const toggleSort = key => setSort(prev => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))

  const sortEmployees = useCallback(list => {
    const direction = sort.dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      const listA = assignmentsByEmployee[a.executorId] || []
      const listB = assignmentsByEmployee[b.executorId] || []
      let diff = 0
      if (sort.key === 'company') diff = (a.company || '').localeCompare(b.company || '', 'ru')
      else if (sort.key === 'fio') diff = (a.fio || '').localeCompare(b.fio || '', 'ru')
      else if (sort.key === 'tsd') diff = (listA.map(x => x.tsd).join(', ') || '').localeCompare(listB.map(x => x.tsd).join(', ') || '', 'ru')
      else if (sort.key === 'status') diff = getEmployeeStatus(a).localeCompare(getEmployeeStatus(b), 'ru')
      else if (sort.key === 'assignedAt') {
        diff = (listA[0]?.assignedAt ? new Date(listA[0].assignedAt).getTime() : 0) -
          (listB[0]?.assignedAt ? new Date(listB[0].assignedAt).getTime() : 0)
      }
      return diff * direction || (a.company || '').localeCompare(b.company || '', 'ru') || (a.fio || '').localeCompare(b.fio || '', 'ru')
    })
  }, [assignmentsByEmployee, getEmployeeStatus, sort])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = employees
      .filter(emp => !company || emp.company === company)
      .filter(emp => statusFilter === 'all' || getEmployeeStatus(emp) === statusFilter)
      .filter(emp => !q || `${emp.fio} ${emp.company}`.toLowerCase().includes(q))
    return sortEmployees(list)
  }, [company, employees, getEmployeeStatus, query, sortEmployees, statusFilter])

  const statusEmployees = useMemo(() => {
    const list = employees
      .filter(emp => !company || emp.company === company)
      .filter(emp => statusFilter === 'all' || getEmployeeStatus(emp) === statusFilter)
    return sortEmployees(list)
  }, [company, employees, getEmployeeStatus, sortEmployees, statusFilter])

  const statusRows = useMemo(() => statusEmployees.flatMap(emp => {
    const activeList = assignmentsByEmployee[emp.executorId] || []
    if (!activeList.length) return [{ key: emp.executorId, employee: emp, assignment: null }]
    return activeList.map(rec => ({ key: `${emp.executorId}-${rec.tsd}`, employee: emp, assignment: rec }))
  }), [assignmentsByEmployee, statusEmployees])

  // Одна строка tsd_assignments = до двух событий журнала: выдача и (если ТСД
  // уже сдан) приём. Разворачиваем в плоский поток и режем по границам
  // периода — сервер отдаёт строку целиком, даже когда в период попало лишь
  // одно из двух её событий (выдали вчера, сдали сегодня).
  const historyEvents = useMemo(() => {
    const fromTs = historyFrom ? new Date(dayStartIso(historyFrom)).getTime() : -Infinity
    const toTs = historyTo ? new Date(dayEndIso(historyTo)).getTime() : Infinity
    const events = []
    for (const rec of history) {
      if (rec.assignedAt) {
        events.push({ key: `${rec.id}-issue`, at: rec.assignedAt, type: 'issue', tsd: rec.tsd, fio: rec.fio, company: rec.company, note: '' })
      }
      if (rec.returnedAt) {
        // returned_by_* пустые — строку закрыл не приём, а выдача этого же ТСД
        // другому сотруднику: assign() гасит активную выдачу (см. TsdService).
        const auto = !rec.returnedByFio && !rec.returnedByExecutorId
        const foreign = !auto && rec.returnedByExecutorId && rec.executorId && rec.returnedByExecutorId !== rec.executorId
        events.push({
          key: `${rec.id}-return`,
          at: rec.returnedAt,
          type: 'return',
          tsd: rec.tsd,
          fio: auto ? rec.fio : (rec.returnedByFio || rec.fio),
          company: auto ? rec.company : (rec.returnedByCompany || rec.company),
          note: auto ? 'Закрыт выдачей другому' : (foreign ? `Сдал за ${rec.fio}` : ''),
        })
      }
    }
    return events
      .filter(ev => {
        const ts = new Date(ev.at).getTime()
        return ts >= fromTs && ts <= toTs
      })
      .sort((a, b) => new Date(b.at) - new Date(a.at))
  }, [history, historyFrom, historyTo])

  const filteredHistory = useMemo(() => {
    const q = historyQuery.trim().toLowerCase()
    return historyEvents
      .filter(ev => historyType === 'all' || ev.type === historyType)
      .filter(ev => !company || ev.company === company)
      .filter(ev => !q || `${ev.fio} ${ev.company} ${ev.tsd}`.toLowerCase().includes(q))
  }, [company, historyEvents, historyQuery, historyType])

  const selectedEmployees = useMemo(() => [...selectedIds].map(id => employeesById.get(id)).filter(Boolean), [employeesById, selectedIds])
  const visibleSelected = filtered.length > 0 && filtered.every(emp => selectedIds.has(emp.executorId))

  const reloadAssignments = useCallback(async () => {
    try {
      const data = await api.getTsdAssignments()
      setAssignments(data?.assignments || [])
      setTsdSettings(data?.settings || { totalCount: 0 })
    } catch (err) {
      setError(err.message || 'Не удалось обновить назначения ТСД')
    }
  }, [])

  // История грузится отдельно от активных выдач: строк за период сильно
  // больше, а на вкладках «Выдача»/«Печать»/«Статусы» они не нужны — поэтому
  // запрос уходит только при открытой вкладке «История» и не участвует в
  // 10-секундном автообновлении.
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const data = await api.getTsdHistory({ from: dayStartIso(historyFrom), to: dayEndIso(historyTo), limit: 2000 })
      setHistory(data?.assignments || [])
      setHistoryError('')
    } catch (err) {
      setHistoryError(err.message || 'Не удалось загрузить историю')
    }
    setHistoryLoading(false)
  }, [historyFrom, historyTo])

  useEffect(() => {
    if (activeTab !== 'history') return
    loadHistory().catch(() => {})
  }, [activeTab, loadHistory])

  const doAssign = payload => api.assignTsd(payload)
  const doReturn = payload => api.returnTsdByBarcode(payload)

  const processScan = useCallback(async raw => {
    const code = normalizeScannerCode(raw)
    if (!code) return
    const employee = employeesById.get(extractEmployeeCode(code))

    if (pendingTsd) {
      if (!employee?.executorId) {
        setMessage('После ТСД нужен QR сотрудника')
        return
      }
      if (pendingTsd.mode === 'return') {
        const res = await doReturn({
          tsd: pendingTsd.tsd,
          returnedByExecutorId: employee.executorId,
          returnedByFio: employee.fio,
          returnedByCompany: employee.company || '',
        })
        await reloadAssignments()
        if (res.foreignReturn) {
          setMessage(`Внимание: ТСД ${pendingTsd.tsd} числился за ${pendingTsd.assignment?.fio || 'другим сотрудником'}, вернул ${employee.fio}`)
        } else {
          setMessage(`ТСД ${pendingTsd.tsd} возвращен: ${employee.fio}`)
        }
        setPendingTsd(null)
        return
      }

      await doAssign({ executorId: employee.executorId, fio: employee.fio, company: employee.company || '', tsd: pendingTsd.tsd })
      await reloadAssignments()
      setMessage(`ТСД ${pendingTsd.tsd} выдан: ${employee.fio}`)
      setPendingTsd(null)
      return
    }

    if (employee?.executorId) {
      setMessage('Для возврата сначала сканируйте ТСД')
      return
    }

    const activeAssignment = assignmentsByTsd[code]
    if (activeAssignment) {
      setPendingTsd({ tsd: code, mode: 'return', assignment: activeAssignment })
      setMessage(`ТСД ${code} числится за ${activeAssignment.fio}. Сканируйте QR того, кто вернул`)
    } else {
      setPendingTsd({ tsd: code, mode: 'assign' })
      setMessage(`ТСД ${code}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignmentsByTsd, employeesById, pendingTsd, reloadAssignments])

  const handleScanSubmit = async e => {
    e.preventDefault()
    try {
      await processScan(scanValue)
      setScanValue('')
    } catch (err) {
      setMessage(err.message || 'Ошибка операции')
    } finally {
      scanRef.current?.focus()
    }
  }

  const toggleOne = executorId => setSelectedIds(prev => {
    const next = new Set(prev)
    next.has(executorId) ? next.delete(executorId) : next.add(executorId)
    return next
  })

  const toggleVisible = () => setSelectedIds(prev => {
    const next = new Set(prev)
    if (visibleSelected) filtered.forEach(emp => next.delete(emp.executorId))
    else filtered.forEach(emp => next.add(emp.executorId))
    return next
  })

  const printEmployees = list => {
    const prepared = (list || []).filter(emp => emp?.executorId)
    if (!prepared.length) { setMessage('Выберите сотрудников для печати'); return }
    setPrintItems(prepared)
    setPrintRequested(true)
  }

  const handleReturn = async (emp, active) => {
    if (!active) return
    try {
      await doReturn({ tsd: active.tsd, returnedByExecutorId: emp.executorId, returnedByFio: emp.fio, returnedByCompany: emp.company || '' })
      await reloadAssignments()
      setMessage(`ТСД ${active.tsd} возвращен: ${emp.fio}`)
    } catch (err) {
      setMessage(err.message || 'Не удалось вернуть ТСД')
    }
  }

  if (loading) {
    return <div className="mx-auto w-full max-w-[1100px] p-6"><Spinner label="Загрузка..." /></div>
  }

  const printLayer = (
    <div className="tsd-print-portal">
      {printItems.map(emp => (
        <div key={emp.executorId} className="tsd-print-label">
          <QrCodeSvg value={employeeCode(emp.executorId)} className="tsd-print-qr" title={emp.fio} />
          <div className="tsd-print-company">{emp.company || '—'}</div>
          <div className="tsd-print-name">{shortFio(emp.fio)}</div>
        </div>
      ))}
    </div>
  )

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-4 p-6">
      <style>{TSD_PRINT_CSS}</style>

      <h1 className="text-xl font-semibold">Выдача ТСД</h1>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          {error}
        </div>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="issue">Выдача</TabsTrigger>
            <TabsTrigger value="print">Печать QR</TabsTrigger>
            <TabsTrigger value="status">Статусы</TabsTrigger>
            <TabsTrigger value="history">История</TabsTrigger>
          </TabsList>

          <div className="flex gap-4 text-sm">
            <div className="flex items-baseline gap-1.5"><span className="text-muted-foreground">Рабочих ТСД</span><strong>{totalTsdCount}</strong></div>
            <div className="flex items-baseline gap-1.5"><span className="text-muted-foreground">Выдано</span><strong>{issuedCount}</strong></div>
            <div className="flex items-baseline gap-1.5"><span className="text-muted-foreground">Остаток</span><strong>{remainingTsdCount}</strong></div>
          </div>
        </div>

        <TabsContent value="issue">
          <div
            className={cn(
              'relative flex min-h-[420px] cursor-text flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed bg-card p-10 text-center transition-colors',
              scanFocused ? 'border-primary/50' : 'border-border'
            )}
            // preventDefault вместо focus() по клику: браузер тогда вообще не
            // снимает фокус с поля, а не снимает-и-возвращает.
            onMouseDown={e => {
              if (e.target.closest?.('button, input, select, [role="button"]')) return
              e.preventDefault()
              focusScan()
            }}
          >
            <div className={cn('flex size-24 items-center justify-center rounded-full', pendingTsd ? 'bg-warning/20 text-warning-foreground' : 'bg-success/15 text-success')}>
              <ScanLine size={56} strokeWidth={1.6} />
            </div>
            <div className="text-lg font-semibold">{pendingTsd ? 'Сканируйте QR сотрудника' : 'Сканируйте ТСД'}</div>

            <form onSubmit={handleScanSubmit} className="w-full max-w-sm">
              <Input
                ref={scanRef}
                value={scanValue}
                onChange={e => setScanValue(e.target.value)}
                onFocus={() => setScanFocused(true)}
                onBlur={handleScanBlur}
                autoComplete="off"
                spellCheck={false}
                placeholder="Код сканируется сюда"
                className="h-11 text-center font-mono text-base"
              />
              <button type="submit" className="sr-only">ОК</button>
            </form>

            <div className={cn('flex items-center gap-1.5 text-sm', scanFocused ? 'text-success' : 'text-muted-foreground')}>
              <span className={cn('size-2 rounded-full', scanFocused ? 'bg-success' : 'bg-muted-foreground')} />
              {scanFocused ? 'Сканер активен' : 'Начните сканировать — поле подхватит код само'}
            </div>

            <div className="max-w-md text-sm">
              {message || (pendingTsd
                ? (pendingTsd.mode === 'return' ? 'После QR сотрудника ТСД будет возвращён' : 'После QR сотрудника ТСД будет закреплён за ним')
                : 'Для возврата сначала сканируйте ТСД')}
            </div>

            {pendingTsd && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => { setPendingTsd(null); setMessage(''); setScanValue(''); focusScan() }}
              >
                Отменить ТСД {pendingTsd.tsd}
              </Button>
            )}
          </div>
        </TabsContent>

        <TabsContent value="print" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select className={selectClass} value={company} onChange={e => setCompany(e.target.value)}>
              <option value="">Все компании</option>
              {companies.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className={selectClass} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="all">Все статусы</option>
              <option value="not_returned">Не сдал</option>
              <option value="returned">Сдал</option>
            </select>
            <Input className="h-8 w-48" placeholder="ФИО" value={query} onChange={e => setQuery(e.target.value)} />
            <Button size="sm" variant={visibleSelected ? 'default' : 'outline'} onClick={toggleVisible}>
              {visibleSelected ? <CheckSquare className="size-3.5" /> : <Square className="size-3.5" />}
              Видимые
            </Button>
            <Button size="sm" onClick={() => printEmployees(selectedEmployees)}><Printer className="size-3.5" /> Печать выбранных</Button>
            <Button size="sm" variant="secondary" onClick={() => printEmployees(filtered)}>
              <Printer className="size-3.5" /> {company ? 'Печать компании' : 'Печать списка'}
            </Button>
            <span className="ml-auto text-sm text-muted-foreground">Выбрано: {selectedIds.size}</span>
          </div>

          <div className="rounded-lg border">
            {/* Мобильные карточки — до md (768px) */}
            <div className="divide-y md:hidden">
              {filtered.map(emp => {
                const activeList = assignmentsByEmployee[emp.executorId] || []
                return (
                  <div key={emp.executorId} className="flex items-start gap-2 p-3 text-sm">
                    <Checkbox className="mt-0.5" checked={selectedIds.has(emp.executorId)} onCheckedChange={() => toggleOne(emp.executorId)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{emp.fio}</span>
                        <Badge variant={activeList.length ? 'warning' : 'success'}>{activeList.length ? 'Не сдал' : 'Сдал'}</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">{emp.company || '—'}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        <span title={activeList.map(x => x.tsd).join(', ')}>ТСД: {activeList.length ? activeList.map(x => x.tsd).join(', ') : '—'}</span>
                        <span>Выдан: {activeList[0]?.assignedAt ? formatDateTime(activeList[0].assignedAt) : '—'}</span>
                      </div>
                    </div>
                    <Button size="icon" variant="ghost" className="shrink-0" onClick={() => printEmployees([emp])} title="Печать бейджа"><Printer className="size-3.5" /></Button>
                  </div>
                )
              })}
              {!filtered.length && <div className="p-6 text-center text-sm text-muted-foreground">Нет сотрудников</div>}
            </div>

            {/* Десктопная таблица — от md и шире */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <SortableHead label="Компания" sortKey="company" sort={sort} onSort={toggleSort} />
                    <SortableHead label="Исполнитель" sortKey="fio" sort={sort} onSort={toggleSort} />
                    <SortableHead label="ТСД" sortKey="tsd" sort={sort} onSort={toggleSort} />
                    <SortableHead label="Статус" sortKey="status" sort={sort} onSort={toggleSort} />
                    <SortableHead label="Выдан" sortKey="assignedAt" sort={sort} onSort={toggleSort} />
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map(emp => {
                    const activeList = assignmentsByEmployee[emp.executorId] || []
                    return (
                      <TableRow key={emp.executorId}>
                        <TableCell><Checkbox checked={selectedIds.has(emp.executorId)} onCheckedChange={() => toggleOne(emp.executorId)} /></TableCell>
                        <TableCell>{emp.company || '—'}</TableCell>
                        <TableCell>{emp.fio}</TableCell>
                        <TableCell title={activeList.map(x => x.tsd).join(', ')}>{activeList.length ? activeList.map(x => x.tsd).join(', ') : '—'}</TableCell>
                        <TableCell><Badge variant={activeList.length ? 'warning' : 'success'}>{activeList.length ? 'Не сдал' : 'Сдал'}</Badge></TableCell>
                        <TableCell>{activeList[0]?.assignedAt ? formatDateTime(activeList[0].assignedAt) : '—'}</TableCell>
                        <TableCell>
                          <Button size="icon" variant="ghost" onClick={() => printEmployees([emp])} title="Печать бейджа"><Printer className="size-3.5" /></Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  {!filtered.length && (
                    <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">Нет сотрудников</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="status" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select className={selectClass} value={company} onChange={e => setCompany(e.target.value)}>
              <option value="">Все компании</option>
              {companies.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className={selectClass} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="all">Все статусы</option>
              <option value="not_returned">Не сдал</option>
              <option value="returned">Сдал</option>
            </select>
          </div>

          <div className="rounded-lg border">
            {/* Мобильные карточки — до md (768px) */}
            <div className="divide-y md:hidden">
              {statusRows.map(row => {
                const emp = row.employee
                const active = row.assignment
                return (
                  <div key={row.key} className="flex items-start justify-between gap-2 p-3 text-sm">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{emp.fio}</span>
                        <Badge variant={active ? 'warning' : 'success'}>{active ? 'Не сдал' : 'Сдал'}</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">{emp.company || '—'}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        <span>ТСД: {active?.tsd || '—'}</span>
                        <span>Выдан: {active?.assignedAt ? formatDateTime(active.assignedAt) : '—'}</span>
                      </div>
                    </div>
                    <Button size="icon" variant="ghost" className="shrink-0" disabled={!active} onClick={() => handleReturn(emp, active)} title="Вернуть без сканирования">
                      <RotateCcw className="size-3.5" />
                    </Button>
                  </div>
                )
              })}
              {!statusRows.length && <div className="p-6 text-center text-sm text-muted-foreground">Нет сотрудников</div>}
            </div>

            {/* Десктопная таблица — от md и шире */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHead label="Компания" sortKey="company" sort={sort} onSort={toggleSort} />
                    <SortableHead label="Исполнитель" sortKey="fio" sort={sort} onSort={toggleSort} />
                    <SortableHead label="ТСД" sortKey="tsd" sort={sort} onSort={toggleSort} />
                    <SortableHead label="Статус" sortKey="status" sort={sort} onSort={toggleSort} />
                    <SortableHead label="Выдан" sortKey="assignedAt" sort={sort} onSort={toggleSort} />
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {statusRows.map(row => {
                    const emp = row.employee
                    const active = row.assignment
                    return (
                      <TableRow key={row.key}>
                        <TableCell>{emp.company || '—'}</TableCell>
                        <TableCell>{emp.fio}</TableCell>
                        <TableCell>{active?.tsd || '—'}</TableCell>
                        <TableCell><Badge variant={active ? 'warning' : 'success'}>{active ? 'Не сдал' : 'Сдал'}</Badge></TableCell>
                        <TableCell>{active?.assignedAt ? formatDateTime(active.assignedAt) : '—'}</TableCell>
                        <TableCell>
                          <Button size="icon" variant="ghost" disabled={!active} onClick={() => handleReturn(emp, active)} title="Вернуть без сканирования">
                            <RotateCcw className="size-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  {!statusRows.length && (
                    <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Нет сотрудников</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </TabsContent>

        {/* Журнал выдачи/приёма — все строки tsd_assignments за период, а не
            только активные; каждая строка разворачивается в 1-2 события. */}
        <TabsContent value="history" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <DateRangePicker
              from={historyFrom}
              to={historyTo}
              onChange={({ from, to }) => { setHistoryFrom(from); setHistoryTo(to || from) }}
              className="h-8"
            />
            <select className={selectClass} value={historyType} onChange={e => setHistoryType(e.target.value)}>
              <option value="all">Все события</option>
              <option value="issue">Только выдача</option>
              <option value="return">Только приём</option>
            </select>
            <select className={selectClass} value={company} onChange={e => setCompany(e.target.value)}>
              <option value="">Все компании</option>
              {companies.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <Input className="h-8 w-48" placeholder="ФИО или ТСД" value={historyQuery} onChange={e => setHistoryQuery(e.target.value)} />
            <Button size="sm" variant="outline" onClick={() => loadHistory()} disabled={historyLoading}>
              <RefreshCw className={cn('size-3.5', historyLoading && 'animate-spin')} /> Обновить
            </Button>
            <span className="ml-auto text-sm text-muted-foreground">Событий: {filteredHistory.length}</span>
          </div>

          {historyError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">{historyError}</div>
          )}

          <div className="rounded-lg border">
            {/* Мобильные карточки — до md (768px) */}
            <div className="divide-y md:hidden">
              {filteredHistory.map(ev => (
                <div key={ev.key} className="p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge variant={ev.type === 'issue' ? 'warning' : 'success'}>{ev.type === 'issue' ? 'Выдача' : 'Приём'}</Badge>
                    <span className="truncate font-medium">{ev.fio || '—'}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">{ev.company || '—'}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <span>ТСД: {ev.tsd}</span>
                    <span>{formatDateTime(ev.at)}</span>
                  </div>
                  {ev.note && <div className="mt-0.5 text-xs text-warning-foreground">{ev.note}</div>}
                </div>
              ))}
              {!filteredHistory.length && (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  {historyLoading ? 'Загрузка...' : 'Нет событий за период'}
                </div>
              )}
            </div>

            {/* Десктопная таблица — от md и шире */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-40">Время</TableHead>
                    <TableHead className="w-28">Событие</TableHead>
                    <TableHead className="w-28">ТСД</TableHead>
                    <TableHead>Исполнитель</TableHead>
                    <TableHead>Компания</TableHead>
                    <TableHead>Примечание</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredHistory.map(ev => (
                    <TableRow key={ev.key}>
                      <TableCell className="whitespace-nowrap">{formatDateTime(ev.at)}</TableCell>
                      <TableCell><Badge variant={ev.type === 'issue' ? 'warning' : 'success'}>{ev.type === 'issue' ? 'Выдача' : 'Приём'}</Badge></TableCell>
                      <TableCell>{ev.tsd}</TableCell>
                      <TableCell>{ev.fio || '—'}</TableCell>
                      <TableCell>{ev.company || '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{ev.note || '—'}</TableCell>
                    </TableRow>
                  ))}
                  {!filteredHistory.length && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground">
                        {historyLoading ? 'Загрузка...' : 'Нет событий за период'}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {createPortal(printLayer, document.body)}
    </div>
  )
}
