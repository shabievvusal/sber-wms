import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { getStoredToken, getPblZones, getPblGate, getPblTaskByBarcode, getProductsById } from '@/lib/wmsFetch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { SortableHead } from '@/components/ui/sortable-head'
import { Spinner } from '@/components/ui/spinner'
import { fmtNum, fmtKg } from './format'
import { RefreshCw } from 'lucide-react'

const selectClass = 'h-8 rounded-md border border-input bg-transparent px-2 text-sm'

// Одновременных запросов в WMS — столько же, сколько у fetchRkFromWms при
// загрузке деталей маршрутов. Полная раскладка по всем воротам — это ~1
// запрос на ворота плюс 1 на каждую стоящую там ЕО (на реальном складе
// суммарно полторы сотни), поэтому грузим батчами, а не Promise.all по всему
// списку сразу.
const BATCH = 5

// Товаров в одном запросе справочника. Лимит эндпоинта неизвестен, а размер
// пачки в реальном запросе терминала — 25 (DevTools, 2026-08-22), поэтому не
// рискуем и повторяем его: лишние несколько запросов дешевле, чем 400 на
// всю выборку сразу.
const PRODUCT_CHUNK = 25

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
 * 184 шт на 166 степов), поэтому обе колонки нужны. Количество копится в
 * разрезе productId — из него потом считается вес по справочнику товаров.
 */
function taskSummary(taskData) {
  const task = unwrap(taskData) || {}
  const steps = task.steps || []
  let planned = 0
  const qtyByProduct = new Map()
  for (const step of steps) {
    for (const product of step.pieceProducts || []) {
      const qty = Number(product.plannedQuantity) || 0
      planned += qty
      if (product.productId) qtyByProduct.set(product.productId, (qtyByProduct.get(product.productId) || 0) + qty)
    }
  }
  return { planned, steps: steps.length, qtyByProduct: [...qtyByProduct] }
}

/** Название товара в строке: одно — как есть, несколько — первое и счётчик остальных (полный список в подсказке). */
function productLabel(names) {
  if (!names.length) return '—'
  if (names.length === 1) return names[0]
  return `${names[0]} +${names.length - 1}`
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
      const gatesDone = `Ворота: ${target.length} / ${target.length}`
      setProgress(`${gatesDone} · ЕО: 0 / ${units.length}`)
      let doneUnits = 0
      const base = await mapLimit(units, BATCH, async unit => {
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
          setProgress(`${gatesDone} · ЕО: ${doneUnits} / ${units.length}`)
        }
        return {
          key: unit.barcode,
          ...unit,
          planned: summary?.planned ?? null,
          steps: summary?.steps ?? null,
          qtyByProduct: summary?.qtyByProduct ?? [],
        }
      })

      // Справочник — одним проходом на всю выборку, а не по товару на строку:
      // на воротах много ЕО с одним и тем же товаром, и повторно спрашивать
      // его название и вес незачем.
      const productIds = [...new Set(base.flatMap(row => row.qtyByProduct.map(([id]) => id)))]
      const catalog = new Map()
      for (let i = 0; i < productIds.length; i += PRODUCT_CHUNK) {
        const chunk = productIds.slice(i, i + PRODUCT_CHUNK)
        setProgress(`${gatesDone} · Товары: ${i} / ${productIds.length}`)
        try {
          const data = unwrap(await getProductsById(token, chunk))
          for (const product of data?.products || []) catalog.set(product.productId, product)
        } catch (err) {
          toast.error('Справочник товаров: ' + err.message)
        }
      }

      setRows(base.map(row => {
        const names = []
        let grams = 0
        let complete = row.qtyByProduct.length > 0
        for (const [id, qty] of row.qtyByProduct) {
          const product = catalog.get(id)
          if (!product) { complete = false; continue }
          if (product.productName) names.push(product.productName)
          grams += (Number(product.weightInGrams) || 0) * qty
        }
        // Вес показываем только когда известны ВСЕ товары ЕО — иначе вышло бы
        // правдоподобное, но заниженное число.
        return { ...row, names, grams: complete ? grams : null }
      }))
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
    return list.filter(row => `${row.barcode} ${row.supplier} ${row.gateName} ${row.names.join(' ')}`.toLowerCase().includes(q))
  }, [rows, search])

  const sorted = useMemo(() => {
    if (!sort.key) return filtered
    const direction = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      if (sort.key === 'gate') return (a.gateName || '').localeCompare(b.gateName || '', 'ru', { numeric: true }) * direction
      if (sort.key === 'product') return (a.names[0] || '').localeCompare(b.names[0] || '', 'ru') * direction
      return ((Number(a[sort.key]) || 0) - (Number(b[sort.key]) || 0)) * direction
    })
  }, [filtered, sort])

  const totals = useMemo(() => sorted.reduce((acc, row) => ({
    planned: acc.planned + (row.planned || 0),
    steps: acc.steps + (row.steps || 0),
    grams: acc.grams + (row.grams || 0),
    noTask: acc.noTask + (row.steps === null ? 1 : 0),
  }), { planned: 0, steps: 0, grams: 0, noTask: 0 }), [sorted])

  // Колонки «Статус» нет (задача на воротах всегда в работе), поэтому ЕО без
  // задачи считаем здесь — иначе они бы молча уехали в строки с прочерками.
  const summaryLine = rows
    ? `ЕО: ${fmtNum(sorted.length)} · ${fmtNum(totals.planned)} шт · ${fmtKg(totals.grams)} · ${fmtNum(totals.steps)} степов`
      + (totals.noTask ? ` · без задачи: ${fmtNum(totals.noTask)}` : '')
    : 'Данные не загружены'

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Раскладка КДК</h1>
        <p className="text-sm text-muted-foreground">Задачи раскладки по ЕО, стоящим на воротах: товар, штуки, вес и степы</p>
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
        <Input className="w-56" placeholder="ЕО, товар, поставщик" value={search} onChange={e => setSearch(e.target.value)} />
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
                  <div className="font-medium" title={row.names.join(', ')}>{productLabel(row.names)}</div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                    <span>Штук: <span className="font-medium text-foreground">{fmtNum(row.planned)}</span></span>
                    <span>Вес: <span className="font-medium text-foreground">{fmtKg(row.grams)}</span></span>
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
                    <SortableHead label="Товар" sortKey="product" sort={sort} onSort={toggleSort} />
                    <SortableHead label="Штук" sortKey="planned" sort={sort} onSort={toggleSort} className="text-right" />
                    <SortableHead label="Вес" sortKey="grams" sort={sort} onSort={toggleSort} className="text-right" />
                    <SortableHead label="Степов" sortKey="steps" sort={sort} onSort={toggleSort} className="text-right" />
                    <TableHead>Поставщик</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map(row => (
                    <TableRow key={row.key}>
                      <TableCell>{row.gateName}</TableCell>
                      <TableCell className="font-mono text-xs">{row.barcode}</TableCell>
                      <TableCell className="max-w-[320px] truncate" title={row.names.join(', ')}>{productLabel(row.names)}</TableCell>
                      <TableCell className="text-right">{fmtNum(row.planned)}</TableCell>
                      <TableCell className="text-right">{fmtKg(row.grams)}</TableCell>
                      <TableCell className="text-right">{fmtNum(row.steps)}</TableCell>
                      <TableCell>{row.supplier || '—'}</TableCell>
                    </TableRow>
                  ))}
                  {!sorted.length && (
                    <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">Нет данных</TableCell></TableRow>
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
