import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import * as api from '@/lib/api'
import { getStoredToken, getLiveMonitorViaBrowser, getPieceSelectionTasks, fetchLastKdkCompletedForExecutor, getPblTaskByBarcode } from '@/lib/wmsFetch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { SortableHead } from '@/components/ui/sortable-head'
import { Spinner } from '@/components/ui/spinner'
import { IDLE_LIMIT_MS, ZONE_OPTIONS, TEMP_OPTIONS } from './constants'
import { fmtAgo, fmtNum, formatTime, shortFio, userName, dateToApiFrom, dateToApiTo, mapLimit } from './format'
import { summarizePblTask } from './pblTask'
import { RefreshCw } from 'lucide-react'

const selectClass = 'h-8 rounded-md border border-input bg-transparent px-2 text-sm'

const BATCH = 5

/** «40 / 166» — сколько степов осталось из скольких всего. */
function stepsLabel(row) {
  if (row.stepsTotal == null) return '—'
  return `${fmtNum(row.stepsLeft)} / ${fmtNum(row.stepsTotal)}`
}

function assignmentsToMap(list) {
  const map = {}
  for (const rec of list || []) {
    if (!rec.executorId) continue
    if (!map[rec.executorId]) map[rec.executorId] = []
    map[rec.executorId].push(rec)
  }
  return map
}

function localDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

// Порт parseKdkRows/parsePieceRows оригинала — компанию тут не резолвим (в
// отличие от оригинала, где это делается сразу по ФИО-фоллбэку): rowsWithTsd
// ниже уже резолвит company по executorId для строк из любого источника.
//
// Структура записи КДК подтверждена реальным ответом монитора (24.08.2026):
// это ровно четыре поля — `id`, `handlingUnitBarcode`, `startedAt`, `user`.
// Раньше здесь перебирались десять возможных имён полей (taskNumber/taskId/
// itemsLeft/quantity/…) — НИ ОДНОГО из них в ответе нет, перебор всегда
// доходил до `handlingUnitBarcode` и отдавал остаток `null`. Убрано: гадание
// маскировало то, что остаток штук приходит вообще из другого запроса
// (fetchLastKdkCompletedForExecutor ниже).
function parseKdkRows(data) {
  const value = data?.value || data || {}
  const entries = value.pickByLineHandlingUnitsInProgress || []
  return entries.map((entry, index) => {
    const user = entry.user || {}
    return {
      key: `kdk-${entry.id || index}`,
      operation: 'КДК',
      executor: userName(user),
      executorId: user.id || '',
      task: entry.handlingUnitBarcode || '—',
      barcode: entry.handlingUnitBarcode || '',
      pieces: null,
      lastActionAt: null,
      stepsTotal: null,
      stepsDone: null,
      stepsLeft: null,
    }
  })
}

function parsePieceRows(items) {
  return (items || []).map((row, index) => {
    const executor = userName(row.responsibleUser)
    const executorId = row.responsibleUser?.id || ''
    const task = row.targetHandlingUnitBarcode || row.id || `ШО-${index + 1}`
    return {
      key: `piece-${row.id || task}-${index}`,
      operation: 'Штучный отбор',
      executor,
      executorId,
      task,
      barcode: '',
      pieces: null,
      lastActionAt: row.updatedAt || row.createdAt || null,
      // Степы есть только у КДК: у штучного отбора нет задачи раскладки.
      stepsTotal: null,
      stepsDone: null,
      stepsLeft: null,
    }
  })
}

// Перенесено из оригинала (frontend/app/src/pages/picking/KdkLayoutPage.jsx)
// — триаж «зависших» исполнителей (КДК + штучный отбор в работе), у кого
// давно не было ни одного пика. Есть настоящий WMS-токен → реальные
// getLiveMonitorViaBrowser/getPieceSelectionTasks/fetchLastKdkCompletedForExecutor
// (прямые браузерные вызовы в WMS); без токена — честная ошибка. Единственный
// same-origin вызов оригинала (getTsdAssignments) — реальный `api.getTsdAssignments()`,
// тот же, что и у TsdIssuePage (это не WMS-вызов, отдельная ось «токен/нет»).
//
// Связка исполнитель→компания — по executorId, без FIO-fallback
// (normalizeFio/getCompanyByFio оригинала не перенесены — тот же принцип,
// что и в MonitorPage, решение от 2026-07-12: «fallback только по executorId»).
export default function KdkLayoutPage() {
  const [rows, setRows] = useState([])
  const [assignments, setAssignments] = useState({})
  const [employees, setEmployees] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState('')
  const [sort, setSort] = useState({ key: 'lastActionAt', dir: 'asc' })
  const [operationFilter, setOperationFilter] = useState('')
  const [tsdStatusFilter, setTsdStatusFilter] = useState('')
  const [idleFilter, setIdleFilter] = useState('')
  const [query, setQuery] = useState('')

  const toggleSort = key => setSort(prev => prev.key === key
    ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
    : { key, dir: key === 'lastActionAt' ? 'asc' : 'desc' })

  const load = async () => {
    setLoading(true)
    setError('')
    const token = getStoredToken()
    try {
      const [{ employees: emplList }, { assignments: activeAssignments }] = await Promise.all([
        api.getEmployees(),
        api.getTsdAssignments(),
      ])
      setEmployees((emplList || []).filter(e => e.executorId))
      setAssignments(assignmentsToMap(activeAssignments))

      if (!token) {
        setRows([])
        setError('Нет активного WMS-токена — войдите паролем от WMS')
        return
      }

      const today = localDay(new Date())
      const tomorrow = new Date(today)
      tomorrow.setDate(tomorrow.getDate() + 1)
      const [live, piece] = await Promise.all([
        getLiveMonitorViaBrowser(token),
        getPieceSelectionTasks(token, {
          dateFrom: dateToApiFrom(today),
          dateTo: dateToApiTo(tomorrow),
          status: ['IN_PROGRESS'],
          sourceZoneId: ZONE_OPTIONS.map(z => z.id),
          shipmentTemperatureMode: TEMP_OPTIONS.map(t => t.value),
          pageNumber: 1,
          pageSize: 500,
        }),
      ])
      // На каждую строку КДК — два запроса: остаток штук на паллете (по
      // исполнителю) и сама задача раскладки (по ШК ЕО, оттуда степы).
      // Пачками, а не Promise.all по всему списку: на смене это под три
      // десятка строк, то есть полсотни одновременных запросов в WMS.
      const kdkRows = await mapLimit(parseKdkRows(live), BATCH, async row => {
        const [lastPick, task] = await Promise.all([
          row.executorId
            ? fetchLastKdkCompletedForExecutor(token, row.executorId).catch(() => null)
            : null,
          row.barcode
            ? getPblTaskByBarcode(token, row.barcode).then(summarizePblTask).catch(() => null)
            : null,
        ])
        return {
          ...row,
          pieces: lastPick?.remainingPieces ?? row.pieces,
          lastActionAt: lastPick?.maxCompletedAt ? new Date(lastPick.maxCompletedAt).toISOString() : null,
          stepsTotal: task?.stepsTotal ?? null,
          stepsDone: task?.stepsDone ?? null,
          stepsLeft: task?.stepsLeft ?? null,
        }
      })
      const pieceItems = (piece?.value ?? piece)?.items ?? []
      setRows([...kdkRows, ...parsePieceRows(pieceItems)])
      setLastUpdated(new Date().toISOString())
    } catch (err) {
      toast.error('Ошибка загрузки: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const companyByExecutorId = useMemo(() => {
    const map = new Map()
    for (const e of employees) if (e.executorId) map.set(e.executorId, e.company)
    return map
  }, [employees])

  const rowsWithTsd = useMemo(() => rows.map(row => {
    const activeList = row.executorId ? assignments[row.executorId] || [] : []
    const idleMs = row.lastActionAt ? Date.now() - new Date(row.lastActionAt).getTime() : null
    return {
      ...row,
      company: (row.executorId && companyByExecutorId.get(row.executorId)) || '—',
      tsd: activeList.map(rec => rec.tsd).filter(Boolean).join(', '),
      tsdStatus: activeList.length ? 'Не сдал' : 'Сдал',
      idle: idleMs == null ? false : idleMs > IDLE_LIMIT_MS,
    }
  }), [assignments, companyByExecutorId, rows])

  const operations = useMemo(() => [...new Set(rowsWithTsd.map(r => r.operation).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')), [rowsWithTsd])

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rowsWithTsd
      .filter(row => !operationFilter || row.operation === operationFilter)
      .filter(row => !tsdStatusFilter || row.tsdStatus === tsdStatusFilter)
      .filter(row => !idleFilter || (idleFilter === 'idle' ? row.idle : !row.idle))
      .filter(row => !q || `${row.operation} ${row.company} ${row.executor} ${row.tsd} ${row.task}`.toLowerCase().includes(q))
  }, [idleFilter, operationFilter, query, rowsWithTsd, tsdStatusFilter])

  const sorted = useMemo(() => {
    const direction = sort.dir === 'asc' ? 1 : -1
    return [...filteredRows].sort((a, b) => {
      let diff = 0
      if (sort.key === 'operation') diff = (a.operation || '').localeCompare(b.operation || '', 'ru')
      else if (sort.key === 'company') diff = (a.company || '').localeCompare(b.company || '', 'ru')
      else if (sort.key === 'executor') diff = (a.executor || '').localeCompare(b.executor || '', 'ru')
      else if (sort.key === 'pieces') {
        const aValue = Number.isFinite(Number(a.pieces)) ? Number(a.pieces) : -1
        const bValue = Number.isFinite(Number(b.pieces)) ? Number(b.pieces) : -1
        diff = aValue - bValue
      } else if (sort.key === 'stepsLeft') {
        diff = (a.stepsLeft ?? -1) - (b.stepsLeft ?? -1)
      } else if (sort.key === 'lastActionAt') {
        diff = (a.lastActionAt ? new Date(a.lastActionAt).getTime() : 0) - (b.lastActionAt ? new Date(b.lastActionAt).getTime() : 0)
      }
      return diff * direction || (a.company || '').localeCompare(b.company || '', 'ru') || (a.executor || '').localeCompare(b.executor || '', 'ru')
    })
  }, [filteredRows, sort])

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Зависшие задачи</h1>
        <p className="text-sm text-muted-foreground">КДК и штучный отбор: исполнитель, ТСД, последний пик и простой</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={load} disabled={loading}>
          <RefreshCw className="size-3.5" /> {loading ? 'Загрузка...' : 'Обновить'}
        </Button>
        <select className={selectClass} value={operationFilter} onChange={e => setOperationFilter(e.target.value)}>
          <option value="">Все операции</option>
          {operations.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className={selectClass} value={tsdStatusFilter} onChange={e => setTsdStatusFilter(e.target.value)}>
          <option value="">Все статусы ТСД</option>
          <option value="Не сдал">Не сдал</option>
          <option value="Сдал">Сдал</option>
        </select>
        <select className={selectClass} value={idleFilter} onChange={e => setIdleFilter(e.target.value)}>
          <option value="">Весь простой</option>
          <option value="idle">Больше 5 минут</option>
          <option value="active">До 5 минут</option>
        </select>
        <Input className="w-56" placeholder="Исполнитель, ТСД, ЕО" value={query} onChange={e => setQuery(e.target.value)} />
        <span className="ml-auto text-sm text-muted-foreground">{lastUpdated ? `Обновлено: ${formatTime(lastUpdated)}` : 'Данные не загружены'}</span>
      </div>

      <div className="rounded-lg border">
        {!loading && !rows.length && <div className="p-8 text-center text-sm text-muted-foreground">Нажмите «Обновить», чтобы проверить зависшие задачи</div>}
        {loading && <Spinner label="Загрузка задач..." />}
        {!loading && rows.length > 0 && (
          <>
            {/* Мобильные карточки — до md (768px) */}
            <div className="divide-y md:hidden">
              {sorted.map(row => (
                <div key={row.key} className={cn('space-y-1.5 p-3 text-sm', row.idle && 'bg-warning/10')}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium" title={row.executor}>{shortFio(row.executor)}</span>
                    <Badge variant={row.tsd ? 'warning' : 'success'}>{row.tsdStatus}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <span>{row.operation}</span>
                    <span>{row.company}</span>
                    <span>ТСД: {row.tsd || '—'}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                    <span>Задача: <span className="text-foreground">{row.task || '—'}</span></span>
                    <span>Остаток: <span className="text-foreground">{row.pieces == null ? '—' : fmtNum(row.pieces)}</span></span>
                    <span>Степов: <span className="text-foreground">{stepsLabel(row)}</span></span>
                  </div>
                  {row.lastActionAt && (
                    <div className={cn('text-xs', row.idle ? 'font-semibold text-warning-foreground' : 'text-muted-foreground')}>
                      Последнее действие: {formatTime(row.lastActionAt)} · простой {fmtAgo(row.lastActionAt)}
                    </div>
                  )}
                </div>
              ))}
              {!sorted.length && <div className="p-6 text-center text-sm text-muted-foreground">Нет задач</div>}
            </div>

            {/* Десктопная таблица — от md и шире */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHead label="Операция" sortKey="operation" sort={sort} onSort={toggleSort} />
                    <SortableHead label="Компания" sortKey="company" sort={sort} onSort={toggleSort} />
                    <SortableHead label="Исполнитель" sortKey="executor" sort={sort} onSort={toggleSort} />
                    <TableHead>ТСД</TableHead>
                    <TableHead>Статус ТСД</TableHead>
                    <TableHead>Задача / ЕО</TableHead>
                    <SortableHead label="Остаток" sortKey="pieces" sort={sort} onSort={toggleSort} className="text-right" />
                    <SortableHead label="Осталось степов" sortKey="stepsLeft" sort={sort} onSort={toggleSort} className="text-right" />
                    <SortableHead label="Последнее действие" sortKey="lastActionAt" sort={sort} onSort={toggleSort} />
                    <TableHead>Простой</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map(row => (
                    <TableRow key={row.key} className={row.idle ? 'bg-warning/10' : ''}>
                      <TableCell>{row.operation}</TableCell>
                      <TableCell>{row.company}</TableCell>
                      <TableCell title={row.executor}>{shortFio(row.executor)}</TableCell>
                      <TableCell>{row.tsd || '—'}</TableCell>
                      <TableCell><Badge variant={row.tsd ? 'warning' : 'success'}>{row.tsdStatus}</Badge></TableCell>
                      <TableCell>{row.task || '—'}</TableCell>
                      <TableCell className="text-right">{row.pieces == null ? '—' : fmtNum(row.pieces)}</TableCell>
                      <TableCell className="text-right" title={row.stepsTotal == null ? '' : `Разложено ${fmtNum(row.stepsDone)} из ${fmtNum(row.stepsTotal)}`}>
                        {stepsLabel(row)}
                      </TableCell>
                      <TableCell>{row.lastActionAt ? <span className={row.idle ? 'font-semibold text-warning-foreground' : ''}>{formatTime(row.lastActionAt)}</span> : '—'}</TableCell>
                      <TableCell>{row.lastActionAt ? <span className={row.idle ? 'font-semibold text-warning-foreground' : ''}>{fmtAgo(row.lastActionAt)}</span> : '—'}</TableCell>
                    </TableRow>
                  ))}
                  {!sorted.length && (
                    <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground">Нет задач</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
