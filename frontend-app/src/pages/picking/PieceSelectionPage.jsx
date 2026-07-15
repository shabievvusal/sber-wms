import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { getStoredToken, getPieceSelectionTasks } from '@/lib/wmsFetch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { DateRangePicker } from '@/components/ui/date-picker'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { SortableHead } from '@/components/ui/sortable-head'
import { Spinner } from '@/components/ui/spinner'
import { DEFAULT_STATUSES, STATUS_LABELS, TEMP_LABELS, TEMP_OPTIONS, ZONE_OPTIONS } from './constants'
import { fmtDay, fmtKg, fmtLiters, fmtNum, userName, dateToApiFrom, dateToApiTo, selectedOrAll } from './format'
import { RefreshCw } from 'lucide-react'

const PAGE_SIZE = 100

const selectClass = 'h-8 rounded-md border border-input bg-transparent px-2 text-sm'
const todayStr = () => new Date().toISOString().slice(0, 10)

const SORT_FIELDS = { cells: 'sourceCellsCount', weight: 'weightInGrams', volume: 'volumeInMilliliters' }

function statusBadgeVariant(status) {
  if (status === 'COMPLETED') return 'success'
  if (status === 'IN_PROGRESS') return 'info'
  if (status === 'CREATED') return 'warning'
  return 'secondary'
}

function sortValue(row, key) {
  return Number(row?.[SORT_FIELDS[key]]) || 0
}

// Перенесено из оригинала (frontend/app/src/pages/picking/PieceSelectionPage.jsx)
// — отчёт по заданиям штучного отбора. Есть настоящий WMS-токен → реальный
// getPieceSelectionTasks (прямой браузерный вызов в api-p01.samokat.ru,
// пагинация по всем страницам, как в оригинале); без токена — прежний
// демо-фильтр по моку. `DateRangeDropdown` оригинала (самодельный календарь,
// ~130 строк) заменён на общий `DateRangePicker` проекта — тот же
// компонент, что и в других разделах, только техническая замена виджета.
export default function PieceSelectionPage() {
  const [dateRange, setDateRange] = useState({ from: todayStr(), to: todayStr() })
  const [status, setStatus] = useState('')
  const [zoneId, setZoneId] = useState('')
  const [temperatureMode, setTemperatureMode] = useState('')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sort, setSort] = useState({ key: '', dir: 'desc' })

  const toggleSort = key => setSort(prev => prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' })

  const load = async () => {
    setLoading(true)
    setError('')
    const token = getStoredToken()
    if (!token) {
      setRows([])
      setError('Нет активного WMS-токена — войдите паролем от WMS')
      setLoading(false)
      return
    }
    try {
      const base = {
        dateFrom: dateToApiFrom(new Date(dateRange.from || todayStr())),
        dateTo: dateToApiTo(new Date(dateRange.to || dateRange.from || todayStr())),
        pageSize: PAGE_SIZE,
        status: status ? [status] : DEFAULT_STATUSES,
        sourceZoneId: selectedOrAll(zoneId, ZONE_OPTIONS, 'id'),
        shipmentTemperatureMode: selectedOrAll(temperatureMode, TEMP_OPTIONS, 'value'),
      }
      const first = await getPieceSelectionTasks(token, { ...base, pageNumber: 1 })
      const firstValue = first?.value ?? first
      const total = firstValue?.total ?? 0
      let items = [...(firstValue?.items ?? [])]
      const pages = Math.ceil(total / PAGE_SIZE)
      if (pages > 1) {
        const rest = await Promise.all(
          Array.from({ length: pages - 1 }, (_, i) => getPieceSelectionTasks(token, { ...base, pageNumber: i + 2 }))
        )
        for (const r of rest) items = items.concat((r?.value ?? r)?.items ?? [])
      }
      setRows(items)
    } catch (err) {
      toast.error('Ошибка загрузки: ' + err.message)
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  const filtered = useMemo(() => {
    const list = rows || []
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(row => String(row.shipTo?.name || '').toLowerCase().includes(q))
  }, [rows, search])

  const sorted = useMemo(() => {
    if (!sort.key) return filtered
    const direction = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => (sortValue(a, sort.key) - sortValue(b, sort.key)) * direction)
  }, [filtered, sort])

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Штучный отбор</h1>
        <p className="text-sm text-muted-foreground">Задания комплектации по штучному отбору</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input className="w-56" placeholder="Поиск по ЦФЗ" value={search} onChange={e => setSearch(e.target.value)} />
        <DateRangePicker from={dateRange.from} to={dateRange.to} onChange={setDateRange} placeholder="Период" />
        <select className={selectClass} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">Все статусы</option>
          {DEFAULT_STATUSES.map(v => <option key={v} value={v}>{STATUS_LABELS[v] || v}</option>)}
        </select>
        <select className={selectClass} value={zoneId} onChange={e => setZoneId(e.target.value)}>
          <option value="">Все зоны</option>
          {ZONE_OPTIONS.map(z => <option key={z.id} value={z.id}>{z.label}</option>)}
        </select>
        <select className={selectClass} value={temperatureMode} onChange={e => setTemperatureMode(e.target.value)}>
          <option value="">Все температуры</option>
          {TEMP_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <Button onClick={load} disabled={loading}>
          <RefreshCw className="size-3.5" /> {loading ? 'Загрузка...' : 'Загрузить'}
        </Button>
        <span className="ml-auto text-sm text-muted-foreground">
          {rows ? `Загружено: ${fmtNum(rows.length)}` : 'Данные не загружены'}
        </span>
      </div>

      <div className="rounded-lg border">
        {!rows && !loading && <div className="p-8 text-center text-sm text-muted-foreground">Выберите период и нажмите «Загрузить»</div>}
        {loading && <Spinner label="Загрузка заданий..." />}
        {rows && !loading && (
          <>
            {/* Мобильные карточки — до md (768px) */}
            <div className="divide-y md:hidden">
              {sorted.map(row => (
                <div key={row.id} className="space-y-1.5 p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{row.shipTo?.name || '—'}</span>
                    <Badge variant={statusBadgeVariant(row.status)}>{STATUS_LABELS[row.status] || row.status || '—'}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                    <span>Ячеек: <span className="font-medium text-foreground">{fmtNum(row.sourceCellsCount)}</span></span>
                    <span>Вес: <span className="font-medium text-foreground">{fmtKg(row.weightInGrams)}</span></span>
                    <span>Объём: <span className="font-medium text-foreground">{fmtLiters(row.volumeInMilliliters)}</span></span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>ШК ЕО: {row.targetHandlingUnitBarcode || '—'}</span>
                    <span>Зона: {row.sourceZone?.name || '—'}</span>
                    <span>Темп.: {(row.shipmentTemperatureModes || []).map(t => TEMP_LABELS[t] || t).join(', ') || '—'}</span>
                    <span>Отгрузка: {fmtDay(row.logisticDate)}</span>
                    <span>Исполнитель: {userName(row.responsibleUser)}</span>
                  </div>
                </div>
              ))}
              {!sorted.length && <div className="p-6 text-center text-sm text-muted-foreground">Нет данных</div>}
            </div>

            {/* Десктопная таблица — от md и шире */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Статус</TableHead>
                    <TableHead>ЦФЗ</TableHead>
                    <SortableHead label="Ячеек" sortKey="cells" sort={sort} onSort={toggleSort} className="text-right" />
                    <SortableHead label="Вес" sortKey="weight" sort={sort} onSort={toggleSort} className="text-right" />
                    <SortableHead label="Объем" sortKey="volume" sort={sort} onSort={toggleSort} className="text-right" />
                    <TableHead>ШК ЕО</TableHead>
                    <TableHead>Зона</TableHead>
                    <TableHead>Температура</TableHead>
                    <TableHead>Дата отгрузки</TableHead>
                    <TableHead>Исполнитель</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map(row => (
                    <TableRow key={row.id}>
                      <TableCell><Badge variant={statusBadgeVariant(row.status)}>{STATUS_LABELS[row.status] || row.status || '—'}</Badge></TableCell>
                      <TableCell>{row.shipTo?.name || '—'}</TableCell>
                      <TableCell className="text-right">{fmtNum(row.sourceCellsCount)}</TableCell>
                      <TableCell className="text-right">{fmtKg(row.weightInGrams)}</TableCell>
                      <TableCell className="text-right">{fmtLiters(row.volumeInMilliliters)}</TableCell>
                      <TableCell>{row.targetHandlingUnitBarcode || '—'}</TableCell>
                      <TableCell>{row.sourceZone?.name || '—'}</TableCell>
                      <TableCell>{(row.shipmentTemperatureModes || []).map(t => TEMP_LABELS[t] || t).join(', ') || '—'}</TableCell>
                      <TableCell>{fmtDay(row.logisticDate)}</TableCell>
                      <TableCell>{userName(row.responsibleUser)}</TableCell>
                    </TableRow>
                  ))}
                  {!sorted.length && (
                    <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground">Нет данных</TableCell></TableRow>
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
