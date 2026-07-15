import { useEffect, useMemo, useRef, useState } from 'react'
import { getStoredToken, getInboundTasks, getInboundTaskDetail, getInboundTaskResponsibleUsers, getEoRemaining } from '@/lib/wmsFetch'
import { toggleSortState } from '@/lib/sort'
import { hashFor, setHash } from '@/lib/hashRoute'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { DateRangePicker } from '@/components/ui/date-picker'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Table, TableHeader, TableBody, TableRow, TableCell } from '@/components/ui/table'
import { SortableHead } from '@/components/ui/sortable-head'
import { Spinner } from '@/components/ui/spinner'
import { Pagination } from '@/components/ui/pagination'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge, PickStatusBadge } from './StatusBadge'
import {
  ALL_STATUSES, STATUS_LABELS, TYPE_LABELS, TEMP_LABELS,
  STATUS_SORT_ORDER, PICK_STATUS_SORT_ORDER, CROSSDOCK_PICK_STATUSES, ACCEPTANCE_RELEVANT_STATUSES,
} from './constants'
import { fmtNum, fmtWeight, fmtDateTime, fioShort, dateToApiFrom, dateToApiTo, qty } from './format'
import { FilterDropdown } from './FilterDropdown'
import SupplyDetailPage from './SupplyDetailPage'
import { Search, SlidersHorizontal } from 'lucide-react'

const PER_PAGE = 30
const LS_COLS_KEY = 'supplies_visible_cols'

// Точный набор, порядок и подписи колонок — из оригинала (COLUMNS в
// frontend/app/src/pages/supplies/SuppliesPage.jsx), включая то, что там по
// умолчанию видны ВСЕ колонки, а не урезанный набор. Единственное отличие:
// 'taskNumber' здесь тоже зафиксирован (fixed) — чтобы всегда было на чём
// поставить настоящую ссылку для «открыть в новой вкладке» (см. PLAN.md).
const COLUMNS = [
  { key: 'status', label: 'Статус', fixed: true },
  { key: 'acceptedBy', label: 'Кто принял' },
  { key: 'taskNumber', label: 'Поставка', fixed: true },
  { key: 'orderNumber', label: 'Заказ' },
  { key: 'plannedDate', label: 'Плановая дата' },
  { key: 'supplier', label: 'Поставщик' },
  { key: 'type', label: 'Тип' },
  { key: 'temperature', label: 'Температура' },
  { key: 'gate', label: 'Ворота' },
  { key: 'planQty', label: 'План. товары' },
  { key: 'planKg', label: 'План, кг' },
  { key: 'factKg', label: 'Факт, кг' },
  { key: 'eo', label: 'ЕО' },
  { key: 'planPcs', label: 'План шт.' },
  { key: 'condition', label: 'Кондиция' },
  { key: 'defect', label: 'Брак' },
  { key: 'startedAt', label: 'Начало приёмки' },
  { key: 'completedAt', label: 'Окончание' },
]

function loadVisibleCols() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_COLS_KEY) || 'null')
    if (Array.isArray(saved) && saved.length) return new Set(saved)
  } catch { /* ignore */ }
  return new Set(COLUMNS.map(c => c.key))
}

function getSortValue(row, key) {
  if (key === 'status') {
    if (row.type === 'CROSSDOCK' && CROSSDOCK_PICK_STATUSES.includes(row.status) && row.pickStatus) {
      return PICK_STATUS_SORT_ORDER[row.pickStatus] ?? PICK_STATUS_SORT_ORDER.waiting
    }
    return STATUS_SORT_ORDER[row.status] ?? -1
  }
  if (key === 'plannedDate') return row.plannedArrivalDate ? new Date(row.plannedArrivalDate).getTime() : 0
  if (['startedAt', 'completedAt'].includes(key)) return row[key] ? new Date(row[key]).getTime() : 0
  if (key === 'planQty') return Number(row.productsQuantity) || 0
  if (key === 'planKg') return Number(row.plannedWeightG) || 0
  if (key === 'factKg') return Number(row.actualWeightG) || 0
  if (key === 'eo') return Number(row.handlingUnitsQuantity) || 0
  if (key === 'planPcs') return Number(row.plannedPieces) || 0
  if (key === 'condition') return Number(row.acceptedPieces) || 0
  if (key === 'defect') return Number(row.defectivePieces) || 0
  if (key === 'supplier') return String(row.supplierName || '').toLowerCase()
  if (key === 'temperature') return String(row.temperatureMode || '').toLowerCase()
  return String(row[key] || '').toLowerCase()
}

function renderCell(row, key) {
  switch (key) {
    case 'status':
      // Для CROSSDOCK с завершённой приёмкой ячейка «Статус» показывает не
      // статус приёмки, а прогресс комплектации — так же, как в оригинале
      // (там это одна и та же колонка, не отдельный столбец).
      if (row.type === 'CROSSDOCK' && CROSSDOCK_PICK_STATUSES.includes(row.status) && row.pickStatus) {
        return <PickStatusBadge status={row.pickStatus} pct={row.pickPct} />
      }
      return <StatusBadge status={row.status} />
    case 'acceptedBy': return row.acceptedBy || '—'
    // Настоящий href — чтобы правая кнопка мыши предлагала «Открыть в новой
    // вкладке»/«Копировать ссылку», а не только программную навигацию по клику.
    case 'taskNumber': return (
      <a href={hashFor('supplies', row.id)} className="font-medium text-foreground hover:underline" onClick={e => e.stopPropagation()}>
        {row.taskNumber}
      </a>
    )
    case 'orderNumber': return row.orderNumber || '—'
    case 'plannedDate': return fmtDateTime(row.plannedArrivalDate)
    case 'supplier': return row.supplierName || '—'
    case 'type': return TYPE_LABELS[row.type] || row.type
    case 'temperature': return TEMP_LABELS[row.temperatureMode] || '—'
    case 'gate': return row.gateNumber || '—'
    case 'planQty': return fmtNum(row.productsQuantity)
    case 'planKg': return fmtWeight(row.plannedWeightG)
    case 'factKg': return fmtWeight(row.actualWeightG)
    case 'eo': return fmtNum(row.handlingUnitsQuantity)
    case 'planPcs': return fmtNum(row.plannedPieces)
    case 'condition': return fmtNum(row.acceptedPieces)
    case 'defect': return fmtNum(row.defectivePieces) || '—'
    case 'startedAt': return fmtDateTime(row.startedAt)
    case 'completedAt': return fmtDateTime(row.completedAt)
    default: return row[key] ?? '—'
  }
}

// Мобильная карточка — карточка на поставку показывает фиксированный базовый
// набор (статус/номер поставки/поставщик/плановая дата, если они видны) сразу,
// а остальные из ТЕКУЩЕГО выбранного в ColumnsMenu набора колонок — по тапу.
// Порядок колонок (десктопная тонкость) в карточке не воспроизводится.
const MOBILE_CORE_KEYS = ['status', 'taskNumber', 'supplier', 'plannedDate']

function MobileSupplyCard({ row, cols, onOpen }) {
  const [expanded, setExpanded] = useState(false)
  const coreCols = cols.filter(c => MOBILE_CORE_KEYS.includes(c.key))
  const restCols = cols.filter(c => !MOBILE_CORE_KEYS.includes(c.key))

  return (
    <div className="p-3 text-sm" onClick={() => onOpen(row.id)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <a href={hashFor('supplies', row.id)} className="font-medium text-foreground hover:underline" onClick={e => e.stopPropagation()}>
            {row.taskNumber}
          </a>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{row.supplierName || '—'}</div>
        </div>
        {renderCell(row, 'status')}
      </div>

      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {coreCols.filter(c => c.key !== 'status' && c.key !== 'taskNumber' && c.key !== 'supplier').map(c => (
          <span key={c.key}>{c.label}: {renderCell(row, c.key)}</span>
        ))}
      </div>

      {restCols.length > 0 && (
        <button
          type="button"
          className="mt-1.5 text-xs text-primary"
          onClick={e => { e.stopPropagation(); setExpanded(v => !v) }}
        >
          {expanded ? 'Скрыть детали' : 'Ещё детали'}
        </button>
      )}

      {expanded && (
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t pt-2 text-xs text-muted-foreground" onClick={e => e.stopPropagation()}>
          {restCols.map(c => (
            <span key={c.key} className="truncate">{c.label}: <span className="text-foreground">{renderCell(row, c.key)}</span></span>
          ))}
        </div>
      )}
    </div>
  )
}

function ColumnsMenu({ visibleCols, onChange }) {
  const toggle = key => {
    const next = new Set(visibleCols)
    next.has(key) ? next.delete(key) : next.add(key)
    onChange(next)
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline"><SlidersHorizontal className="size-3.5" /> Колонки</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <div className="max-h-80 space-y-0.5 overflow-y-auto">
          {COLUMNS.map(c => (
            <label key={c.key} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
              <Checkbox checked={visibleCols.has(c.key)} disabled={c.fixed} onCheckedChange={() => toggle(c.key)} />
              {c.label}{c.fixed && <span className="text-xs text-muted-foreground">(всегда)</span>}
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default function SuppliesPage({ initialId }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [allRows, setAllRows] = useState(null)
  const [pickStatusMap, setPickStatusMap] = useState({})
  const [respUsersMap, setRespUsersMap] = useState({})
  const fetchedPickRef = useRef(new Set())
  const fetchedRespRef = useRef(new Set())
  const [search, setSearch] = useState('')
  const [acceptorFilter, setAcceptorFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState([])
  const [typeFilter, setTypeFilter] = useState([])
  const [tempFilter, setTempFilter] = useState([])
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [sort, setSort] = useState({ key: 'plannedDate', dir: 'desc' })
  const [page, setPage] = useState(1)
  const [visibleCols, setVisibleCols] = useState(loadVisibleCols)
  const [selectedId, setSelectedId] = useState(initialId || null)

  // Реальная загрузка (есть WMS-токен) — поставки за плановую дату (по
  // умолчанию сегодня, как в оригинале). Перезагрузка при смене диапазона
  // плановой даты (тот же приём, что и в оригинале, только один диапазон
  // вместо раздельных planned/completed — их в new zlp никогда не было
  // двух, см. PLAN.md).
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError('')
      const token = getStoredToken()
      if (!token) {
        if (!cancelled) { setAllRows([]); setError('Нет активного WMS-токена — войдите паролем от WMS'); setLoading(false) }
        return
      }
      const today = new Date().toISOString().slice(0, 10)
      const base = { dateFrom: dateToApiFrom(dateFrom || today), dateTo: dateToApiTo(dateTo || dateFrom || today) }
      try {
        const first = await getInboundTasks(token, { ...base, pageNumber: 1, pageSize: 100 })
        const total = first?.value?.total ?? 0
        let items = [...(first?.value?.items ?? [])]
        const pages = Math.ceil(total / 100)
        if (pages > 1) {
          const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => getInboundTasks(token, { ...base, pageNumber: i + 2, pageSize: 100 })))
          for (const r of rest) items = items.concat(r?.value?.items ?? [])
        }
        if (cancelled) return
        setAllRows(items)
        setPickStatusMap({})
        setRespUsersMap({})
        fetchedPickRef.current.clear()
        fetchedRespRef.current.clear()
      } catch (err) {
        if (!cancelled) { setAllRows([]); setError(err.message || 'Не удалось загрузить поставки') }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo])

  // Строка адреса — источник истины для того, какая поставка открыта (см.
  // hashRoute.js): переход по ссылке/новая вкладка/кнопка «Назад» браузера
  // должны отражаться здесь, а не только клик по строке таблицы.
  useEffect(() => { setSelectedId(initialId || null) }, [initialId])

  useEffect(() => {
    try { localStorage.setItem(LS_COLS_KEY, JSON.stringify([...visibleCols])) } catch { /* ignore */ }
  }, [visibleCols])

  // Комплектация CROSSDOCK — только когда есть реальные данные.
  useEffect(() => {
    if (!allRows) return
    const token = getStoredToken()
    if (!token) return
    const toFetch = allRows.filter(r => r.type === 'CROSSDOCK' && CROSSDOCK_PICK_STATUSES.includes(r.status) && !fetchedPickRef.current.has(r.id))
    if (toFetch.length === 0) return
    toFetch.forEach(r => fetchedPickRef.current.add(r.id))
    setPickStatusMap(prev => { const next = { ...prev }; toFetch.forEach(r => { next[r.id] = 'loading' }); return next })
    let cancelled = false
    Promise.all(toFetch.map(async row => {
      try {
        const res = await getInboundTaskDetail(token, { taskType: row.type, id: row.id })
        const detail = res?.value ?? res
        const huByBarcode = {}
        for (const prod of (detail?.products ?? [])) {
          for (const part of (prod.parts ?? [])) {
            for (const hu of (part.handlingUnits ?? [])) {
              if (hu.handlingUnitBarcode) huByBarcode[hu.handlingUnitBarcode] = (huByBarcode[hu.handlingUnitBarcode] ?? 0) + (qty(hu.actualQuantity) ?? 0)
            }
          }
        }
        const uniqueHus = Object.entries(huByBarcode).map(([barcode, received]) => ({ barcode, received }))
        if (uniqueHus.length === 0) {
          if (!cancelled) setPickStatusMap(prev => ({ ...prev, [row.id]: { status: 'waiting', pct: 0 } }))
          return
        }
        const remainings = await Promise.all(uniqueHus.map(hu => getEoRemaining(token, hu.barcode)))
        if (cancelled) return
        const totalReceived = uniqueHus.reduce((s, hu) => s + hu.received, 0)
        const totalPicked = uniqueHus.reduce((s, hu, i) => { const rem = remainings[i]; return s + (rem === null ? 0 : Math.max(0, hu.received - rem)) }, 0)
        const pct = totalReceived > 0 ? Math.round(totalPicked / totalReceived * 100) : 0
        const allNone = remainings.every(r => r === null)
        const allDone = remainings.every(r => r === 0)
        const status = allNone ? 'waiting' : allDone ? 'done' : 'in_progress'
        setPickStatusMap(prev => ({ ...prev, [row.id]: { status, pct } }))
      } catch {
        if (!cancelled) setPickStatusMap(prev => ({ ...prev, [row.id]: { status: 'waiting', pct: 0 } }))
      }
    }))
    return () => { cancelled = true }
  }, [allRows])

  // «Кто принял» — тоже только для реальных данных.
  useEffect(() => {
    if (!allRows) return
    const token = getStoredToken()
    if (!token) return
    const toFetch = allRows.filter(r => ACCEPTANCE_RELEVANT_STATUSES.includes(r.status) && !fetchedRespRef.current.has(r.id))
    if (toFetch.length === 0) return
    toFetch.forEach(r => fetchedRespRef.current.add(r.id))
    setRespUsersMap(prev => { const next = { ...prev }; toFetch.forEach(r => { next[r.id] = 'loading' }); return next })
    let cancelled = false
    Promise.all(toFetch.map(async row => {
      try {
        const res = await getInboundTaskResponsibleUsers(token, { taskType: row.type, id: row.id })
        const users = res?.value?.responsibleUsers ?? []
        const accepted = users.find(u => u.type === 'ACCEPTANCE_COMPLETED') ?? users.find(u => u.type === 'ACCEPTANCE_STARTED')
        if (!cancelled) setRespUsersMap(prev => ({ ...prev, [row.id]: accepted?.user ?? null }))
      } catch {
        if (!cancelled) setRespUsersMap(prev => ({ ...prev, [row.id]: null }))
      }
    }))
    return () => { cancelled = true }
  }, [allRows])

  // Мердж сырых строк + карт обогащения — те же имена полей (pickStatus/
  // pickPct/acceptedBy), что уже ожидают getSortValue/renderCell выше.
  const supplies = useMemo(() => {
    const rows = allRows ?? []
    return rows.map(row => {
      const ps = pickStatusMap[row.id]
      const respUser = respUsersMap[row.id]
      return {
        ...row,
        pickStatus: ps && ps !== 'loading' ? ps.status : null,
        pickPct: ps && ps !== 'loading' ? ps.pct : null,
        acceptedBy: respUser && respUser !== 'loading' ? fioShort(respUser) : (row.acceptedBy ?? null),
      }
    })
  }, [allRows, pickStatusMap, respUsersMap])

  const acceptorOptions = useMemo(() => [...new Set(supplies.map(s => s.acceptedBy).filter(Boolean))], [supplies])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const acc = acceptorFilter.trim().toLowerCase()
    return supplies.filter(s => {
      if (statusFilter.length && !statusFilter.includes(s.status)) return false
      if (typeFilter.length && !typeFilter.includes(s.type)) return false
      if (tempFilter.length && !tempFilter.includes(s.temperatureMode)) return false
      if (dateFrom && s.plannedArrivalDate < new Date(dateFrom).toISOString()) return false
      if (dateTo) {
        const toDate = new Date(dateTo); toDate.setHours(23, 59, 59, 999)
        if (s.plannedArrivalDate > toDate.toISOString()) return false
      }
      if (acc && !(s.acceptedBy || '').toLowerCase().includes(acc)) return false
      if (q && !(s.taskNumber.toLowerCase().includes(q) || s.orderNumber.toLowerCase().includes(q) || s.supplierName.toLowerCase().includes(q))) return false
      return true
    })
  }, [supplies, search, acceptorFilter, statusFilter, typeFilter, tempFilter, dateFrom, dateTo])

  const sorted = useMemo(() => {
    if (!sort.key) return filtered
    const arr = [...filtered]
    arr.sort((a, b) => {
      const va = getSortValue(a, sort.key), vb = getSortValue(b, sort.key)
      const cmp = va < vb ? -1 : va > vb ? 1 : 0
      return sort.dir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [filtered, sort])

  const totalPages = Math.max(1, Math.ceil(sorted.length / PER_PAGE))
  const curPage = Math.min(page, totalPages)
  const pageItems = sorted.slice((curPage - 1) * PER_PAGE, curPage * PER_PAGE)
  const toggleSort = key => { setSort(s => toggleSortState(s, key)); setPage(1) }
  const cols = COLUMNS.filter(c => c.fixed || visibleCols.has(c.key))

  const hasFilters = statusFilter.length || typeFilter.length || tempFilter.length || dateFrom || dateTo || acceptorFilter
  const clearFilters = () => { setStatusFilter([]); setTypeFilter([]); setTempFilter([]); setDateFrom(''); setDateTo(''); setAcceptorFilter(''); setPage(1) }

  if (selectedId) {
    // Строка уже загружена в этом же компоненте — передаём её напрямую, не
    // заставляем SupplyDetailPage искать заново по одному id (для реального
    // фетча ей всё равно нужен ещё и row.type).
    const selectedRow = supplies.find(s => s.id === selectedId)
    return <SupplyDetailPage row={selectedRow} onBack={() => setHash('supplies')} />
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Поставки</h1>
        <p className="text-sm text-muted-foreground">Приёмка входящих поставок — импорт, кросс-докинг, хранение</p>
      </div>

      {error && <div className="text-sm text-destructive">{error}</div>}

      <div className="space-y-3 rounded-lg border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-xs">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" placeholder="Поиск по № поставки/заказа, поставщику..." value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} />
          </div>
          <FilterDropdown label="Статус" options={ALL_STATUSES.map(s => ({ value: s, label: STATUS_LABELS[s] }))} selected={statusFilter} onChange={v => { setStatusFilter(v); setPage(1) }} />
          <FilterDropdown label="Тип" options={Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label }))} selected={typeFilter} onChange={v => { setTypeFilter(v); setPage(1) }} />
          <FilterDropdown label="Температура" options={Object.entries(TEMP_LABELS).map(([value, label]) => ({ value, label }))} selected={tempFilter} onChange={v => { setTempFilter(v); setPage(1) }} />
          <DateRangePicker from={dateFrom} to={dateTo} onChange={r => { setDateFrom(r.from); setDateTo(r.to); setPage(1) }} placeholder="Плановая дата" className="w-56" />
          <Input className="w-52" list="acceptor-options" placeholder="Кто принял..." value={acceptorFilter} onChange={e => { setAcceptorFilter(e.target.value); setPage(1) }} />
          <datalist id="acceptor-options">
            {acceptorOptions.map(a => <option key={a} value={a} />)}
          </datalist>
          {hasFilters && <Button size="sm" variant="ghost" onClick={clearFilters}>✕ Сбросить</Button>}
          <div className="ml-auto"><ColumnsMenu visibleCols={visibleCols} onChange={setVisibleCols} /></div>
        </div>
      </div>

      <Card className="overflow-visible">
        <CardHeader className="flex-row items-center justify-between gap-2 border-b p-4">
          <CardTitle>Список поставок</CardTitle>
          <span className="text-sm text-muted-foreground">Всего: {sorted.length}</span>
        </CardHeader>

        {sorted.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5 text-xs text-muted-foreground">
            <span>
              Стр. {curPage}/{totalPages} • {(curPage - 1) * PER_PAGE + 1}–{Math.min(curPage * PER_PAGE, sorted.length)} из {sorted.length}
            </span>
            <Pagination page={curPage} totalPages={totalPages} onChange={setPage} />
          </div>
        )}

        <div>
          {loading ? (
            <Spinner label="Загрузка поставок..." />
          ) : sorted.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Нет поставок по заданным фильтрам</div>
          ) : (
            <>
              {/* Мобильные карточки — до md (768px) */}
              <div className="divide-y md:hidden">
                {pageItems.map(row => (
                  <MobileSupplyCard key={row.id} row={row} cols={cols} onOpen={id => setHash('supplies', id)} />
                ))}
              </div>

              {/* Десктопная таблица — от md и шире */}
              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {cols.map(c => (
                        <SortableHead key={c.key} label={c.label} sortKey={c.key} sort={sort} onSort={toggleSort} />
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageItems.map(row => (
                      <TableRow key={row.id} className="cursor-pointer" onClick={() => setHash('supplies', row.id)}>
                        {cols.map(c => <TableCell key={c.key}>{renderCell(row, c.key)}</TableCell>)}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>
      </Card>
    </div>
  )
}
