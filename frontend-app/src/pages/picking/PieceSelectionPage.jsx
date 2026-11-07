import { useEffect, useMemo, useState } from 'react'
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
import { ArrowDown, ArrowUp, Printer, RefreshCw, Search, X } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { AddressLabelsPrint, printAddressLabels } from './AddressLabels'
import { Select } from '@/components/ui/select'

const PAGE_SIZE = 100

const selectClass = 'h-8 rounded-md border border-input bg-transparent px-2 text-sm'
const todayStr = () => new Date().toISOString().slice(0, 10)

const SORT_FIELDS = { cells: 'sourceCellsCount', weight: 'weightInGrams', volume: 'volumeInMilliliters' }
// кнопки сортировки в мобильной версии — те же ключи, что у колонок таблицы
const MOBILE_SORTS = [
  { key: 'cells', label: 'Ячеек' },
  { key: 'weight', label: 'Вес' },
  { key: 'volume', label: 'Объём' },
  { key: 'name', label: 'ЦФЗ' },
]

function statusBadgeVariant(status) {
  if (status === 'COMPLETED') return 'success'
  if (status === 'IN_PROGRESS') return 'info'
  if (status === 'CREATED') return 'warning'
  return 'secondary'
}

function sortValue(row, key) {
  return Number(row?.[SORT_FIELDS[key]]) || 0
}

function compareRows(a, b, key) {
  if (key === 'name') return String(a.shipTo?.name || '').localeCompare(String(b.shipTo?.name || ''), 'ru')
  return sortValue(a, key) - sortValue(b, key)
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
  // поиск по ЕО — отдельный запрос в WMS (targetHandlingUnitBarcode), без
  // фильтров статуса/зоны/температуры; eoFound — ЕО, по которой показаны строки
  const [eo, setEo] = useState('')
  const [eoFound, setEoFound] = useState('')
  const [rows, setRows] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sort, setSort] = useState({ key: '', dir: 'desc' })
  // этикетки с адресами: отмеченные задания (или все показанные) печатаются
  // в порядке таблицы — бригадир сам раскладывает их как удобно
  const [selected, setSelected] = useState(() => new Set())
  const [printItems, setPrintItems] = useState([])
  // мобильная версия: раскрытая карточка (подробности задания)
  const [expanded, setExpanded] = useState(null)

  // числа — сначала большие, ЦФЗ — по алфавиту
const toggleSort = key => setSort(prev => prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'name' ? 'asc' : 'desc' })

  const load = async (eoBarcode = '') => {
    setLoading(true)
    setError('')
    setSelected(new Set())
    const token = getStoredToken()
    if (!token) {
      setRows([])
      setError('Нет активного WMS-токена — войдите паролем от WMS')
      setLoading(false)
      return
    }
    try {
      const period = {
        dateFrom: dateToApiFrom(new Date(dateRange.from || todayStr())),
        dateTo: dateToApiTo(new Date(dateRange.to || dateRange.from || todayStr())),
        pageSize: PAGE_SIZE,
      }
      const base = eoBarcode
        ? { ...period, status: null, targetHandlingUnitBarcode: eoBarcode }
        : {
            ...period,
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
      setEoFound(eoBarcode)
      if (eoBarcode && !items.length) toast.info(`По ЕО ${eoBarcode} за выбранный период заданий нет`)
    } catch (err) {
      toast.error('Ошибка загрузки: ' + err.message)
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  const searchEo = () => {
    const code = eo.replace(/s+/g, '')
    if (!code) { toast.error('Введите ШК ЕО'); return }
    load(code)
  }
  const resetEo = () => { setEo(''); load() }

  const filtered = useMemo(() => {
    const list = rows || []
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(row => String(row.shipTo?.name || '').toLowerCase().includes(q))
  }, [rows, search])

  const sorted = useMemo(() => {
    if (!sort.key) return filtered
    const direction = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => compareRows(a, b, sort.key) * direction)
  }, [filtered, sort])

  const toggleOne = id => setSelected(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const shownSelected = sorted.filter(r => selected.has(r.id))
  const allShownSelected = sorted.length > 0 && shownSelected.length === sorted.length
  const toggleAllShown = () => setSelected(allShownSelected ? new Set() : new Set(sorted.map(r => r.id)))
  // отмечено — печатаем отмеченные, иначе всё, что показано (с фильтрами), — в порядке таблицы
  const toPrint = shownSelected.length ? shownSelected : sorted

  const handlePrint = () => {
    if (!toPrint.length) { toast.error('Нет заданий для печати'); return }
    setPrintItems(toPrint)
  }
  // печать — когда слой с этикетками уже отрисован
  useEffect(() => {
    if (!printItems.length) return
    const id = window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      printAddressLabels()
      setPrintItems([])
    }))
    return () => window.cancelAnimationFrame(id)
  }, [printItems])

  return (
    <div className="mx-auto w-full space-y-4 p-6">
      {printItems.length > 0 && <AddressLabelsPrint items={printItems} />}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Штучный отбор</h1>
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
        <Select className={selectClass} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">Все статусы</option>
          {DEFAULT_STATUSES.map(v => <option key={v} value={v}>{STATUS_LABELS[v] || v}</option>)}
        </Select>
        <Select className={selectClass} value={zoneId} onChange={e => setZoneId(e.target.value)}>
          <option value="">Все зоны</option>
          {ZONE_OPTIONS.map(z => <option key={z.id} value={z.id}>{z.label}</option>)}
        </Select>
        <Select className={selectClass} value={temperatureMode} onChange={e => setTemperatureMode(e.target.value)}>
          <option value="">Все температуры</option>
          {TEMP_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </Select>
        <Button onClick={() => load()} disabled={loading}>
          <RefreshCw className="size-3.5" /> {loading ? 'Загрузка...' : 'Загрузить'}
        </Button>
        <form className="flex items-center gap-1" onSubmit={e => { e.preventDefault(); searchEo() }}>
          <Input className="w-44 font-mono" placeholder="ШК ЕО (022…)" value={eo} onChange={e => setEo(e.target.value)} inputMode="numeric" />
          <Button type="submit" variant="secondary" disabled={loading}>
            <Search className="size-3.5" /> Найти ЕО
          </Button>
        </form>
        <span className="ml-auto text-sm text-muted-foreground">
          {rows ? `Загружено: ${fmtNum(rows.length)}` : 'Данные не загружены'}
        </span>
      </div>

      {eoFound && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand/30 bg-brand-soft/40 px-3 py-2 text-sm">
          <Search className="size-4 text-muted-foreground" />
          <span>
            Задания по ЕО <span className="font-mono font-semibold">{eoFound}</span> за выбранный период — все статусы, зоны и температуры
          </span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={resetEo} disabled={loading}>
            <X className="size-3.5" /> Сбросить поиск
          </Button>
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-surface-2/40 px-3 py-2 text-sm">
          <Printer className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">
            Этикетки с адресами 100×75 мм — в порядке таблицы (отсортируйте как удобно).
            {shownSelected.length ? ` Отмечено: ${shownSelected.length}.` : ' Ничего не отмечено — напечатаются все показанные.'}
          </span>
          {shownSelected.length > 0 && (
            <button type="button" className="text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={() => setSelected(new Set())}>снять отметки</button>
          )}
          <Button size="sm" className="ml-auto" onClick={handlePrint} disabled={!toPrint.length}>
            <Printer className="size-3.5" /> Печать этикеток ({toPrint.length})
          </Button>
        </div>
      )}

      <div className="rounded-lg border">
        {!rows && !loading && <div className="p-8 text-center text-sm text-muted-foreground">Выберите период и нажмите «Загрузить»</div>}
        {loading && <Spinner label="Загрузка заданий..." />}
        {rows && !loading && (
          <>
            {/* Мобильная версия — до md (768px). Для бригадира, который раздаёт
                задания: сортировка кнопками сверху и в строке только нужное —
                ЦФЗ, ячеек, вес, объём, статус (и кто взял, если в работе).
                Остальное (ШК ЕО, зона, температура, отгрузка) — по нажатию.
                Оригинал: карточка со всеми полями, без сортировки. */}
            <div className="md:hidden">
              <div className="flex items-center gap-1.5 overflow-x-auto border-b px-3 py-2">
                <span className="shrink-0 text-xs text-muted-foreground">Сортировка:</span>
                {MOBILE_SORTS.map(m => {
                  const active = sort.key === m.key
                  return (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => toggleSort(m.key)}
                      className={`flex shrink-0 items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${active ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted-foreground'}`}
                    >
                      {m.label}{active && (sort.dir === 'desc' ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                    </button>
                  )
                })}
              </div>
              <div className="divide-y">
                {sorted.map(row => {
                  const open = expanded === row.id
                  return (
                    <div key={row.id} className={`px-3 py-2.5 text-sm ${selected.has(row.id) ? 'bg-brand-soft/40' : ''}`}>
                      <div className="flex items-center gap-2.5">
                        <Checkbox checked={selected.has(row.id)} onCheckedChange={() => toggleOne(row.id)} aria-label="Отметить для печати" />
                        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setExpanded(open ? null : row.id)}>
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate font-medium">{row.shipTo?.name || '—'}</span>
                            {row.status !== 'CREATED' && <Badge variant={statusBadgeVariant(row.status)}>{STATUS_LABELS[row.status] || row.status || '—'}</Badge>}
                          </div>
                          <div className="mt-1 grid grid-cols-3 gap-2 text-center">
                            <div><div className="text-base font-semibold leading-tight">{fmtNum(row.sourceCellsCount)}</div><div className="text-[11px] text-muted-foreground">ячеек</div></div>
                            <div><div className="text-base font-semibold leading-tight">{fmtKg(row.weightInGrams)}</div><div className="text-[11px] text-muted-foreground">вес</div></div>
                            <div><div className="text-base font-semibold leading-tight">{fmtLiters(row.volumeInMilliliters)}</div><div className="text-[11px] text-muted-foreground">объём</div></div>
                          </div>
                          {row.status === 'IN_PROGRESS' && row.responsibleUser && (
                            <div className="mt-1 truncate text-xs text-muted-foreground">Взял: {userName(row.responsibleUser)}</div>
                          )}
                        </button>
                      </div>
                      {open && (
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 pl-7 text-xs text-muted-foreground">
                          <span>ШК ЕО: {row.targetHandlingUnitBarcode || '—'}</span>
                          <span>Зона: {row.sourceZone?.name || '—'}</span>
                          <span>Темп.: {(row.shipmentTemperatureModes || []).map(t => TEMP_LABELS[t] || t).join(', ') || '—'}</span>
                          <span>Отгрузка: {fmtDay(row.logisticDate)}</span>
                          {row.status !== 'IN_PROGRESS' && <span>Исполнитель: {userName(row.responsibleUser)}</span>}
                        </div>
                      )}
                    </div>
                  )
                })}
                {!sorted.length && <div className="p-6 text-center text-sm text-muted-foreground">Нет данных</div>}
              </div>
            </div>

            {/* Десктопная таблица — от md и шире */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <Checkbox checked={allShownSelected ? true : shownSelected.length ? 'indeterminate' : false} onCheckedChange={toggleAllShown} aria-label="Отметить все показанные" />
                    </TableHead>
                    <TableHead>Статус</TableHead>
                    <SortableHead label="ЦФЗ" sortKey="name" sort={sort} onSort={toggleSort} />
                    <SortableHead label="Ячеек" sortKey="cells" sort={sort} onSort={toggleSort} className="text-center" />
                    <SortableHead label="Вес" sortKey="weight" sort={sort} onSort={toggleSort} className="text-center" />
                    <SortableHead label="Объем" sortKey="volume" sort={sort} onSort={toggleSort} className="text-center" />
                    <TableHead>ШК ЕО</TableHead>
                    <TableHead>Зона</TableHead>
                    <TableHead>Температура</TableHead>
                    <TableHead>Дата отгрузки</TableHead>
                    <TableHead>Исполнитель</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map(row => (
                    <TableRow key={row.id} className={selected.has(row.id) ? 'bg-brand-soft/40' : undefined}>
                      <TableCell><Checkbox checked={selected.has(row.id)} onCheckedChange={() => toggleOne(row.id)} aria-label="Отметить для печати" /></TableCell>
                      <TableCell><Badge variant={statusBadgeVariant(row.status)}>{STATUS_LABELS[row.status] || row.status || '—'}</Badge></TableCell>
                      <TableCell>{row.shipTo?.name || '—'}</TableCell>
                      <TableCell className="text-center">{fmtNum(row.sourceCellsCount)}</TableCell>
                      <TableCell className="text-center">{fmtKg(row.weightInGrams)}</TableCell>
                      <TableCell className="text-center">{fmtLiters(row.volumeInMilliliters)}</TableCell>
                      <TableCell>{row.targetHandlingUnitBarcode || '—'}</TableCell>
                      <TableCell>{row.sourceZone?.name || '—'}</TableCell>
                      <TableCell>{(row.shipmentTemperatureModes || []).map(t => TEMP_LABELS[t] || t).join(', ') || '—'}</TableCell>
                      <TableCell>{fmtDay(row.logisticDate)}</TableCell>
                      <TableCell>{userName(row.responsibleUser)}</TableCell>
                    </TableRow>
                  ))}
                  {!sorted.length && (
                    <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground">Нет данных</TableCell></TableRow>
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
