import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { getStoredToken, getPblZones, getPblGate, getPblTaskByBarcode } from '@/lib/wmsFetch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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

/** ЕО, стоящие на воротах: receipts[] → handlingUnits[], поставщик — с уровня receipt. */
function gateUnits(gateData, zoneName) {
  const gate = unwrap(gateData) || {}
  const units = []
  for (const receipt of gate.receipts || []) {
    for (const unit of receipt.handlingUnits || []) {
      units.push({
        barcode: unit.barcode,
        supplier: receipt.supplier?.name || '',
        gateName: zoneName || gate.name || '',
      })
    }
  }
  return units
}

/**
 * Свод задачи раскладки по одной ЕО. Штуки и степы — разные числа: в одной
 * ячейке может лежать больше одной штуки (в разобранных 21.08 задачах —
 * 184 шт на 166 степов), поэтому обе колонки нужны.
 *
 * Наименования товара в задаче нет — только productId (UUID), справочника
 * товаров у страницы пока нет, поэтому «Товар» — это количество разных
 * товаров в задаче, а не название (решение от 2026-08-21: GUID в таблицу
 * не выводим).
 */
function taskSummary(taskData) {
  const task = unwrap(taskData) || {}
  const steps = task.steps || []
  let planned = 0
  const productIds = new Set()
  for (const step of steps) {
    for (const product of step.pieceProducts || []) {
      planned += Number(product.plannedQuantity) || 0
      if (product.productId) productIds.add(product.productId)
    }
  }
  return { planned, steps: steps.length, products: productIds.size }
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
        try {
          summary = taskSummary(await getPblTaskByBarcode(token, unit.barcode))
        } catch {
          // ЕО стоит на воротах, но задачи раскладки по ней нет (или она уже
          // закрыта) — это нормальное состояние, строку показываем всё равно
          // с прочерками, а общее число таких ЕО — в сводке над таблицей.
          summary = null
        } finally {
          doneUnits += 1
          setProgress(`Ворота: ${target.length} / ${target.length} · ЕО: ${doneUnits} / ${units.length}`)
        }
        return {
          key: unit.barcode,
          ...unit,
          planned: summary?.planned ?? null,
          steps: summary?.steps ?? null,
          products: summary?.products ?? null,
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
    return list.filter(row => `${row.barcode} ${row.supplier} ${row.gateName}`.toLowerCase().includes(q))
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
    noTask: acc.noTask + (row.steps === null ? 1 : 0),
  }), { planned: 0, steps: 0, noTask: 0 }), [sorted])

  // Колонки «Статус» нет (задача на воротах всегда в работе), поэтому ЕО без
  // задачи считаем здесь — иначе они бы молча уехали в строки с прочерками.
  const summaryLine = rows
    ? `ЕО: ${fmtNum(sorted.length)} · ${fmtNum(totals.planned)} шт · ${fmtNum(totals.steps)} степов`
      + (totals.noTask ? ` · без задачи: ${fmtNum(totals.noTask)}` : '')
    : 'Данные не загружены'

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Раскладка КДК</h1>
        <p className="text-sm text-muted-foreground">Задачи раскладки по ЕО, стоящим на воротах: штуки и степы</p>
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
        <Input className="w-56" placeholder="ЕО, поставщик, ворота" value={search} onChange={e => setSearch(e.target.value)} />
        <Button onClick={load} disabled={loading}>
          <RefreshCw className="size-3.5" /> {loading ? 'Загрузка...' : 'Загрузить'}
        </Button>
        <span className="ml-auto text-sm text-muted-foreground">
          {loading && progress ? progress : summaryLine}
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
                    <span className="text-xs text-muted-foreground">{row.gateName}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                    <span>Товар: <span className="font-medium text-foreground">{fmtNum(row.products)}</span></span>
                    <span>Штук: <span className="font-medium text-foreground">{fmtNum(row.planned)}</span></span>
                    <span>Степов: <span className="font-medium text-foreground">{fmtNum(row.steps)}</span></span>
                  </div>
                  <div className="text-xs text-muted-foreground">Поставщик: {row.supplier || '—'}</div>
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
                    <SortableHead label="Товар" sortKey="products" sort={sort} onSort={toggleSort} className="text-right" />
                    <SortableHead label="Штук" sortKey="planned" sort={sort} onSort={toggleSort} className="text-right" />
                    <SortableHead label="Степов" sortKey="steps" sort={sort} onSort={toggleSort} className="text-right" />
                    <TableHead>Поставщик</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map(row => (
                    <TableRow key={row.key}>
                      <TableCell>{row.gateName}</TableCell>
                      <TableCell className="font-mono text-xs">{row.barcode}</TableCell>
                      <TableCell className="text-right">{fmtNum(row.products)}</TableCell>
                      <TableCell className="text-right">{fmtNum(row.planned)}</TableCell>
                      <TableCell className="text-right">{fmtNum(row.steps)}</TableCell>
                      <TableCell>{row.supplier || '—'}</TableCell>
                    </TableRow>
                  ))}
                  {!sorted.length && (
                    <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Нет данных</TableCell></TableRow>
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
