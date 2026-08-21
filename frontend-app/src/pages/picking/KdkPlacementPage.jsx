import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { getStoredToken, getPblZones, getPblGate, getPblTaskByBarcode } from '@/lib/wmsFetch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { SortableHead } from '@/components/ui/sortable-head'
import { Spinner } from '@/components/ui/spinner'
import { fmtNum } from './format'
import { RefreshCw } from 'lucide-react'

const selectClass = 'h-8 rounded-md border border-input bg-transparent px-2 text-sm'

// Одновременных запросов в WMS — столько же, сколько у fetchRkFromWms при
// загрузке деталей маршрутов. Полная раскладка по всем воротам — это ~1
// запрос на ворота плюс 1 на каждую стоящую там ЕО (на реальном складе
// суммарно полторы сотни), поэтому грузим батчами, а не Promise.all по всему
// списку сразу.
const BATCH = 5

async function mapLimit(items, limit, fn) {
  const out = []
  for (let i = 0; i < items.length; i += limit) {
    out.push(...await Promise.all(items.slice(i, i + limit).map(fn)))
  }
  return out
}

const unwrap = data => data?.value ?? data

/** ЕО, стоящие на воротах: receipts[] → handlingUnits[], поставщик и номер поставки — с уровня receipt. */
function gateUnits(gateData, zoneName) {
  const gate = unwrap(gateData) || {}
  const units = []
  for (const receipt of gate.receipts || []) {
    for (const unit of receipt.handlingUnits || []) {
      units.push({
        barcode: unit.barcode,
        cell: unit.cell?.name || '',
        supplier: receipt.supplier?.name || '',
        inbound: receipt.inboundNumber || '',
        gateName: zoneName || gate.name || '',
        gateCode: gate.name || '',
      })
    }
  }
  return units
}

/**
 * Свод задачи раскладки по одной ЕО. Штуки и степы — разные числа: в одной
 * ячейке может лежать больше одной штуки (в разобранных 21.08 задачах —
 * 184 шт на 166 степов), поэтому обе колонки нужны.
 */
function taskSummary(taskData) {
  const task = unwrap(taskData) || {}
  const steps = task.steps || []
  let planned = 0
  let accepted = 0
  const productIds = new Set()
  for (const step of steps) {
    for (const product of step.pieceProducts || []) {
      planned += Number(product.plannedQuantity) || 0
      accepted += Number(product.acceptedQuantity) || 0
      if (product.productId) productIds.add(product.productId)
    }
  }
  return {
    taskId: task.taskId || null,
    planned,
    accepted,
    steps: steps.length,
    productIds: [...productIds],
    readyToComplete: !!task.readyToComplete,
  }
}

// Наименования товара в задаче раскладки нет — только productId (UUID), и в
// детализации ворот его тоже нет. Пока справочник товаров не подключён,
// показываем короткий префикс UUID (полный — в title), чтобы колонка не врала
// прочерком там, где товар на самом деле известен системе.
function productLabel(productIds) {
  if (!productIds.length) return '—'
  if (productIds.length === 1) return productIds[0].slice(0, 8)
  const last = productIds.length % 10
  const tens = productIds.length % 100
  const word = tens >= 11 && tens <= 14 ? 'товаров' : last === 1 ? 'товар' : last >= 2 && last <= 4 ? 'товара' : 'товаров'
  return `${productIds.length} ${word}`
}

export default function KdkPlacementPage() {
  const [zones, setZones] = useState([])
  const [gateId, setGateId] = useState('')
  const [rows, setRows] = useState(null)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState({ key: '', dir: 'desc' })

  const toggleSort = key => setSort(prev => prev.key === key
    ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
    : { key, dir: 'desc' })

  // Справочник ворот — один дешёвый запрос, нужен до «Загрузить», иначе
  // фильтр по воротам нечем наполнить (и нельзя грузить только одни ворота
  // вместо всего склада).
  useEffect(() => {
    const token = getStoredToken()
    if (!token) {
      setError('Нет активного WMS-токена — войдите паролем от WMS')
      return
    }
    getPblZones(token)
      .then(data => setZones(unwrap(data)?.zones || []))
      .catch(err => setError('Не удалось загрузить ворота: ' + err.message))
  }, [])

  const load = async () => {
    const token = getStoredToken()
    if (!token) {
      setRows([])
      setError('Нет активного WMS-токена — войдите паролем от WMS')
      return
    }
    setLoading(true)
    setError('')
    setProgress('')
    try {
      const fresh = unwrap(await getPblZones(token))?.zones || []
      setZones(fresh)
      const target = gateId ? fresh.filter(z => z.gateId === gateId) : fresh
      if (!target.length) {
        setRows([])
        return
      }

      setProgress(`Ворота: 0 / ${target.length}`)
      let doneGates = 0
      const unitLists = await mapLimit(target, BATCH, async zone => {
        try {
          return gateUnits(await getPblGate(token, zone.gateId), zone.name)
        } catch (err) {
          toast.error(`${zone.name}: ${err.message}`)
          return []
        } finally {
          doneGates += 1
          setProgress(`Ворота: ${doneGates} / ${target.length}`)
        }
      })

      const units = unitLists.flat()
      setProgress(`Ворота: ${target.length} / ${target.length} · ЕО: 0 / ${units.length}`)
      let doneUnits = 0
      const result = await mapLimit(units, BATCH, async unit => {
        let summary = null
        let taskError = null
        try {
          summary = taskSummary(await getPblTaskByBarcode(token, unit.barcode))
        } catch (err) {
          // ЕО стоит на воротах, но задачи раскладки по ней нет (или она уже
          // закрыта) — это нормальное состояние, строку показываем всё равно.
          taskError = err.message
        } finally {
          doneUnits += 1
          setProgress(`Ворота: ${target.length} / ${target.length} · ЕО: ${doneUnits} / ${units.length}`)
        }
        return {
          key: unit.barcode,
          ...unit,
          planned: summary?.planned ?? null,
          accepted: summary?.accepted ?? null,
          steps: summary?.steps ?? null,
          productIds: summary?.productIds ?? [],
          readyToComplete: summary?.readyToComplete ?? false,
          taskError,
        }
      })
      setRows(result)
    } catch (err) {
      toast.error('Ошибка загрузки: ' + err.message)
      setRows([])
    } finally {
      setLoading(false)
      setProgress('')
    }
  }

  const filtered = useMemo(() => {
    const list = rows || []
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(row => `${row.barcode} ${row.supplier} ${row.inbound} ${row.gateName}`.toLowerCase().includes(q))
  }, [rows, search])

  const sorted = useMemo(() => {
    if (!sort.key) return filtered
    const direction = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      if (sort.key === 'gate') return (a.gateName || '').localeCompare(b.gateName || '', 'ru', { numeric: true }) * direction
      return ((Number(a[sort.key]) || 0) - (Number(b[sort.key]) || 0)) * direction
    })
  }, [filtered, sort])

  const totals = useMemo(() => sorted.reduce((acc, row) => ({
    planned: acc.planned + (row.planned || 0),
    steps: acc.steps + (row.steps || 0),
  }), { planned: 0, steps: 0 }), [sorted])

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Раскладка КДК</h1>
        <p className="text-sm text-muted-foreground">Задачи раскладки по ЕО, стоящим на воротах: товар, штуки и степы</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select className={selectClass} value={gateId} onChange={e => setGateId(e.target.value)}>
          <option value="">Все ворота{zones.length ? ` (${zones.reduce((n, z) => n + (z.handlingUnitsCount || 0), 0)} ЕО)` : ''}</option>
          {zones.map(zone => (
            <option key={zone.gateId} value={zone.gateId}>{zone.name} ({fmtNum(zone.handlingUnitsCount)} ЕО)</option>
          ))}
        </select>
        <Input className="w-56" placeholder="ЕО, поставщик, поставка" value={search} onChange={e => setSearch(e.target.value)} />
        <Button onClick={load} disabled={loading}>
          <RefreshCw className="size-3.5" /> {loading ? 'Загрузка...' : 'Загрузить'}
        </Button>
        <span className="ml-auto text-sm text-muted-foreground">
          {loading && progress ? progress : rows ? `ЕО: ${fmtNum(sorted.length)} · ${fmtNum(totals.planned)} шт · ${fmtNum(totals.steps)} степов` : 'Данные не загружены'}
        </span>
      </div>

      <div className="rounded-lg border">
        {!rows && !loading && <div className="p-8 text-center text-sm text-muted-foreground">Выберите ворота и нажмите «Загрузить»</div>}
        {loading && <Spinner label={progress || 'Загрузка раскладки...'} />}
        {rows && !loading && (
          <>
            {/* Мобильные карточки — до md (768px) */}
            <div className="divide-y md:hidden">
              {sorted.map(row => (
                <div key={row.key} className="space-y-1.5 p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-medium">{row.barcode}</span>
                    <Badge variant={row.taskError ? 'secondary' : row.readyToComplete ? 'success' : 'info'}>
                      {row.taskError ? 'Нет задачи' : row.readyToComplete ? 'Готова к закрытию' : 'В работе'}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                    <span>{row.gateName}</span>
                    <span>Штук: <span className="font-medium text-foreground">{fmtNum(row.planned)}</span></span>
                    <span>Степов: <span className="font-medium text-foreground">{fmtNum(row.steps)}</span></span>
                    <span>Разложено: <span className="font-medium text-foreground">{fmtNum(row.accepted)}</span></span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span title={row.productIds.join(', ')}>Товар: {productLabel(row.productIds)}</span>
                    <span>Поставщик: {row.supplier || '—'}</span>
                    <span>Поставка: {row.inbound || '—'}</span>
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
                    <SortableHead label="Ворота" sortKey="gate" sort={sort} onSort={toggleSort} />
                    <TableHead>ЕО</TableHead>
                    <TableHead>Товар</TableHead>
                    <SortableHead label="Штук" sortKey="planned" sort={sort} onSort={toggleSort} className="text-right" />
                    <SortableHead label="Степов" sortKey="steps" sort={sort} onSort={toggleSort} className="text-right" />
                    <SortableHead label="Разложено" sortKey="accepted" sort={sort} onSort={toggleSort} className="text-right" />
                    <TableHead>Поставщик</TableHead>
                    <TableHead>Поставка</TableHead>
                    <TableHead>Статус</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map(row => (
                    <TableRow key={row.key}>
                      <TableCell>{row.gateName}</TableCell>
                      <TableCell className="font-mono text-xs">{row.barcode}</TableCell>
                      <TableCell title={row.productIds.join(', ')}>{productLabel(row.productIds)}</TableCell>
                      <TableCell className="text-right">{fmtNum(row.planned)}</TableCell>
                      <TableCell className="text-right">{fmtNum(row.steps)}</TableCell>
                      <TableCell className="text-right">{fmtNum(row.accepted)}</TableCell>
                      <TableCell>{row.supplier || '—'}</TableCell>
                      <TableCell>{row.inbound || '—'}</TableCell>
                      <TableCell>
                        <Badge variant={row.taskError ? 'secondary' : row.readyToComplete ? 'success' : 'info'}>
                          {row.taskError ? 'Нет задачи' : row.readyToComplete ? 'Готова к закрытию' : 'В работе'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!sorted.length && (
                    <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground">Нет данных</TableCell></TableRow>
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
