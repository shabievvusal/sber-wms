import { useEffect, useMemo, useState } from 'react'
import { getStoredToken, getInboundTaskDetail, getInboundTaskResponsibleUsers, getEoRemaining } from '@/lib/wmsFetch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetBody } from '@/components/ui/sheet'
import { StatusBadge, PickStatusBadge } from './StatusBadge'
import { TYPE_LABELS, TEMP_LABELS } from './constants'
import { fmtNum, fmtWeight, fmtDate, fmtDateTime, fioShort, qty } from './format'
import { ArrowLeft, Search, ChevronDown, Copy, Users } from 'lucide-react'

const EVENT_LABELS = {
  TRANSPORTATION_ASSIGNED: 'Назначен транспорт',
  GATE_ASSIGNED: 'Назначены ворота',
  ACCEPTANCE_STARTED: 'Начата приёмка',
  ACCEPTANCE_COMPLETED: 'Завершена приёмка',
  ACCEPTANCE_CANCELLED: 'Приёмка отменена',
  ACCEPTANCE_SUSPENDED: 'Приёмка приостановлена',
  VERIFIED: 'Проверено',
}

const RESP_GROUPS = [
  { key: 'prep', label: 'Подготовка', types: ['TRANSPORTATION_ASSIGNED', 'GATE_ASSIGNED'] },
  { key: 'acceptance', label: 'Приёмка на ТСД', types: ['ACCEPTANCE_STARTED', 'ACCEPTANCE_CANCELLED', 'ACCEPTANCE_SUSPENDED'] },
  { key: 'check', label: 'Проверка', types: ['ACCEPTANCE_COMPLETED', 'VERIFIED'] },
]

function SideField({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value || '—'}</span>
    </div>
  )
}

function EoPanel({ products, remainingMap, onOpenChange }) {
  const [expanded, setExpanded] = useState(() => new Set())
  const toggle = barcode => setExpanded(prev => {
    const next = new Set(prev)
    next.has(barcode) ? next.delete(barcode) : next.add(barcode)
    return next
  })

  const units = products.flatMap(p => p.parts.flatMap(part => part.handlingUnits.map(u => ({ ...u, product: p, part }))))

  // Значок комплектации по ЕО (только если remainingMap реально заполнен —
  // т.е. пришли настоящие данные, а не мок): null → «Не начато», 0 → 100%,
  // иначе процент от исходного количества.
  function pickBadge(barcode, totalQty) {
    if (!remainingMap || !(barcode in remainingMap)) return null
    const rem = remainingMap[barcode]
    if (rem === null) return <span className="text-xs text-muted-foreground">Не начато</span>
    if (rem === 0) return <span className="text-xs text-success">100%</span>
    const pct = totalQty > 0 ? Math.round((totalQty - rem) / totalQty * 100) : 0
    return <span className="text-xs text-accent-foreground">{pct}%</span>
  }

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Единицы отгрузки/приёмки (ЕО)</SheetTitle>
        </SheetHeader>
        <SheetBody className="space-y-2">
          {units.map(u => (
            <div key={u.handlingUnitBarcode} className="rounded-md border">
              <button className="flex w-full items-center gap-2 p-2.5 text-left text-sm" onClick={() => toggle(u.handlingUnitBarcode)}>
                <ChevronDown className={`size-3.5 shrink-0 transition-transform ${expanded.has(u.handlingUnitBarcode) ? '' : '-rotate-90'}`} />
                <span className="font-mono text-xs">{u.handlingUnitBarcode}</span>
                <span
                  role="button" tabIndex={-1}
                  className="ml-1 text-muted-foreground hover:text-foreground"
                  onClick={e => { e.stopPropagation(); navigator.clipboard?.writeText(u.handlingUnitBarcode).catch(() => {}) }}
                  title="Копировать штрихкод"
                >
                  <Copy className="size-3" />
                </span>
                {pickBadge(u.handlingUnitBarcode, qty(u.actualQuantity) ?? 0)}
                <span className="ml-auto text-xs text-muted-foreground">{fmtNum(u.actualQuantity)} шт.</span>
              </button>
              {expanded.has(u.handlingUnitBarcode) && (
                <div className="flex items-center gap-3 border-t p-2.5">
                  <img src={u.product.imageUrl} alt="" className="size-12 shrink-0 rounded-md object-cover" onError={e => { e.target.style.display = 'none' }} />
                  <div className="min-w-0 text-xs">
                    <div className="truncate font-medium">{u.product.name}</div>
                    <div className="text-muted-foreground">Годен до {fmtDate(u.part.bestBeforeDate)}</div>
                  </div>
                </div>
              )}
            </div>
          ))}
          {units.length === 0 && <div className="text-sm text-muted-foreground">Нет данных по ЕО</div>}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}

function ExecutorsPanel({ users, onOpenChange }) {
  const [collapsed, setCollapsed] = useState(() => new Set())
  const toggle = key => setCollapsed(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Исполнители</SheetTitle>
        </SheetHeader>
        <SheetBody className="space-y-3">
          {RESP_GROUPS.map(g => {
            const events = users.filter(u => g.types.includes(u.type))
            if (!events.length) return null
            const isCollapsed = collapsed.has(g.key)
            return (
              <div key={g.key}>
                <button className="flex w-full items-center gap-1.5 py-1 text-left text-sm font-medium" onClick={() => toggle(g.key)}>
                  <ChevronDown className={`size-3.5 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                  {g.label}
                </button>
                {!isCollapsed && (
                  <div className="space-y-1.5 pl-5">
                    {events.map((e, i) => (
                      <div key={i} className="text-sm">
                        <div>{EVENT_LABELS[e.type] || e.type}</div>
                        <div className="text-xs text-muted-foreground">{fioShort(e.user)} · {e.user?.role} · {fmtDateTime(e.timestamp)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {users.length === 0 && <div className="text-sm text-muted-foreground">Нет данных об исполнителях</div>}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}

// В реальном API plannedQuantity/actualQuantity приходят как
// {pieceProducts:N}/{weightProducts:N}, а не плоским числом (см. qty() в
// format.js) — приводим товары к плоской форме, которую ожидает рендер.
function mapRealProduct(prod) {
  return { ...prod, plannedQuantity: qty(prod.plannedQuantity) ?? 0, actualQuantity: qty(prod.actualQuantity) ?? 0 }
}

export default function SupplyDetailPage({ row, onBack }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState('')
  const [pickStatus, setPickStatus] = useState(null)
  const [pickPct, setPickPct] = useState(null)
  const [remainingMap, setRemainingMap] = useState(null)
  const [respUsers, setRespUsers] = useState(null)
  const [respLoading, setRespLoading] = useState(false)

  const [productSearch, setProductSearch] = useState('')
  const [eoOpen, setEoOpen] = useState(false)
  const [executorsOpen, setExecutorsOpen] = useState(false)

  useEffect(() => {
    if (!row) return
    let cancelled = false
    const token = getStoredToken()
    if (!token) {
      setDetail(null)
      setError('Нет активного WMS-токена — войдите паролем от WMS')
      return
    }
    getInboundTaskDetail(token, { taskType: row.type, id: row.id })
      .then(res => {
        if (cancelled) return
        const raw = res?.value ?? res
        setDetail({ ...raw, products: (raw.products ?? []).map(mapRealProduct) })
        setError('')
      })
      .catch(err => {
        if (cancelled) return
        setDetail(null)
        setError(err.message || 'Не удалось загрузить данные поставки')
      })
    return () => { cancelled = true }
  }, [row])

  // Статус комплектации — только для CROSSDOCK и только с реальными данными.
  useEffect(() => {
    if (!detail || error || row?.type !== 'CROSSDOCK') return
    const token = getStoredToken()
    if (!token) return
    const huByBarcode = {}
    for (const prod of (detail.products ?? [])) {
      for (const part of (prod.parts ?? [])) {
        for (const hu of (part.handlingUnits ?? [])) {
          if (hu.handlingUnitBarcode) huByBarcode[hu.handlingUnitBarcode] = (huByBarcode[hu.handlingUnitBarcode] ?? 0) + (qty(hu.actualQuantity) ?? 0)
        }
      }
    }
    const uniqueHus = Object.entries(huByBarcode).map(([barcode, received]) => ({ barcode, received }))
    if (uniqueHus.length === 0) return
    let cancelled = false
    Promise.all(uniqueHus.map(hu => getEoRemaining(token, hu.barcode))).then(remainings => {
      if (cancelled) return
      const map = {}
      uniqueHus.forEach((hu, i) => { map[hu.barcode] = remainings[i] })
      setRemainingMap(map)
      const totalReceived = uniqueHus.reduce((s, hu) => s + hu.received, 0)
      const totalPicked = uniqueHus.reduce((s, hu, i) => { const rem = remainings[i]; return s + (rem === null ? 0 : Math.max(0, hu.received - rem)) }, 0)
      setPickPct(totalReceived > 0 ? Math.round(totalPicked / totalReceived * 100) : 0)
      const allNone = remainings.every(r => r === null)
      const allDone = remainings.every(r => r === 0)
      setPickStatus(allNone ? 'waiting' : allDone ? 'done' : 'in_progress')
    }).catch(() => {})
    return () => { cancelled = true }
  }, [detail, error, row])

  async function openExecutors() {
    setExecutorsOpen(true)
    if (respUsers !== null) return
    const token = getStoredToken()
    if (!token) { setRespUsers([]); return }
    setRespLoading(true)
    try {
      const res = await getInboundTaskResponsibleUsers(token, { taskType: row.type, id: row.id })
      setRespUsers(res?.value?.responsibleUsers ?? [])
    } catch {
      setRespUsers([])
    } finally {
      setRespLoading(false)
    }
  }

  if (!row || !detail) {
    return (
      <div className="mx-auto w-full max-w-[1200px] space-y-4 p-6">
        <Button variant="secondary" onClick={onBack}><ArrowLeft className="size-4" /> Назад</Button>
        {error && <div className="text-sm text-destructive">{error}</div>}
        {!error && <div className="p-8 text-center text-sm text-muted-foreground">{row ? 'Загрузка...' : 'Поставка не найдена'}</div>}
      </div>
    )
  }

  const displayPickStatus = error ? row.pickStatus : pickStatus
  const displayPickPct = error ? row.pickPct : pickPct

  const q = productSearch.trim().toLowerCase()
  const products = detail.products.filter(p => !q || p.name.toLowerCase().includes(q) || p.nomenclatureCode.toLowerCase().includes(q) || p.productBarcode.toLowerCase().includes(q))
  const totals = products.reduce((acc, p) => ({
    planned: acc.planned + p.plannedQuantity,
    actual: acc.actual + p.actualQuantity,
    units: acc.units + p.handlingUnitQuantity,
  }), { planned: 0, actual: 0, units: 0 })

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-4 p-6">
      {eoOpen && <EoPanel products={detail.products} remainingMap={error ? null : remainingMap} onOpenChange={setEoOpen} />}
      {executorsOpen && <ExecutorsPanel users={respUsers || []} onOpenChange={setExecutorsOpen} />}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={onBack}><ArrowLeft className="size-4" /> Назад</Button>
        <div>
          <h1 className="text-lg font-semibold">{row.taskNumber} <span className="font-normal text-muted-foreground">· заказ {row.orderNumber}</span></h1>
          <p className="text-sm text-muted-foreground">{TYPE_LABELS[row.type]}</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={row.status} />
          {row.type === 'CROSSDOCK' && <PickStatusBadge status={displayPickStatus} pct={displayPickPct} />}
        </div>
        <Button size="sm" variant="outline" className="ml-auto" onClick={openExecutors} disabled={respLoading}>
          <Users className="size-3.5" /> Посмотреть исполнителей
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_280px]">
        <ProductsCard products={products} totals={totals} productSearch={productSearch} setProductSearch={setProductSearch} onOpenEo={() => setEoOpen(true)} eoCount={detail.products.reduce((n, p) => n + p.handlingUnitQuantity, 0)} />

        <div className="space-y-3 rounded-lg border bg-card p-4">
          <div className="font-semibold">Сведения</div>
          <SideField label="Поставщик" value={row.supplierName} />
          <SideField label="Ворота" value={row.gateNumber} />
          <SideField label="Температурный режим" value={TEMP_LABELS[row.temperatureMode]} />
          <SideField label="Транспорт" value={detail.transportation?.vehicle?.number} />
          <SideField label="Водитель" value={detail.transportation?.driver && `${detail.transportation.driver.lastName} ${detail.transportation.driver.firstName}`} />
          <SideField label="Плановая дата" value={fmtDateTime(row.plannedArrivalDate)} />
          <SideField label="Начало приёмки" value={fmtDateTime(row.startedAt)} />
          <SideField label="Завершение" value={fmtDateTime(row.completedAt)} />
          <SideField label="Плановый вес" value={fmtWeight(row.plannedWeightG)} />
          <SideField label="Фактический вес" value={fmtWeight(row.actualWeightG)} />
        </div>
      </div>
    </div>
  )
}

function ProductsCard({ products, totals, productSearch, setProductSearch, onOpenEo, eoCount }) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b p-4">
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Поиск по товару, артикулу, ШК..." value={productSearch} onChange={e => setProductSearch(e.target.value)} />
        </div>
        <Button size="sm" variant="outline" className="ml-auto" onClick={onOpenEo}>ЕО ({fmtNum(eoCount)})</Button>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Товар</TableHead>
              <TableHead>Артикул</TableHead>
              <TableHead>Штрихкод</TableHead>
              <TableHead className="text-right">План</TableHead>
              <TableHead className="text-right">Факт</TableHead>
              <TableHead className="text-right">ЕО</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map(p => {
              const diff = p.actualQuantity - p.plannedQuantity
              return (
                <TableRow key={p.id}>
                  <TableCell className="flex items-center gap-2">
                    <img src={p.imageUrl} alt="" className="size-8 shrink-0 rounded object-cover" onError={e => { e.target.style.display = 'none' }} />
                    <span className="max-w-56 truncate" title={p.name}>{p.name}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{p.nomenclatureCode}</TableCell>
                  <TableCell className="font-mono text-xs">{p.productBarcode}</TableCell>
                  <TableCell className="text-right">{fmtNum(p.plannedQuantity)}</TableCell>
                  <TableCell className={`text-right ${diff < 0 ? 'text-destructive' : diff > 0 ? 'text-success' : ''}`}>{fmtNum(p.actualQuantity)}</TableCell>
                  <TableCell className="text-right">{fmtNum(p.handlingUnitQuantity)}</TableCell>
                </TableRow>
              )
            })}
            {products.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Ничего не найдено</TableCell></TableRow>
            )}
          </TableBody>
          {products.length > 0 && (
            <tfoot>
              <TableRow className="bg-muted/30 font-medium hover:bg-muted/30">
                <TableCell colSpan={3}>Итого</TableCell>
                <TableCell className="text-right">{fmtNum(totals.planned)}</TableCell>
                <TableCell className="text-right">{fmtNum(totals.actual)}</TableCell>
                <TableCell className="text-right">{fmtNum(totals.units)}</TableCell>
              </TableRow>
            </tfoot>
          )}
        </Table>
      </div>
    </div>
  )
}
