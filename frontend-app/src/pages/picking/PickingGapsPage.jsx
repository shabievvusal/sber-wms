import { Fragment, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { getStoredToken, getShipmentOrders, getShipmentOrderDetail, getPieceSelectionTasks } from '@/lib/wmsFetch'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { DateRangePicker } from '@/components/ui/date-picker'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { TEMP_OPTIONS, TEMP_LABELS, SHIPMENT_ORDER_STATUS_LABELS } from './constants'
import { fmtNum, fmtDay, userName, dateToApiFrom, dateToApiTo } from './format'
import { RefreshCw, Download, TriangleAlert, ChevronDown, ChevronRight } from 'lucide-react'

const todayStr = () => new Date().toISOString().slice(0, 10)
const DETAIL_BATCH = 5
const SHIPMENT_STATUSES = ['WAITING_FOR_PICKING', 'PICKING']

// Пропуски в отборе (2026-07-31): находим заказы, зависшие в WAITING_FOR_
// PICKING/PICKING с непобранными товарами, даём пользователю самому
// отметить, какие товары считать приоритетными («тяжёлые», которые
// пропускают), и по отмеченным строим отчёт — кто из сотрудников (через
// «Штучный отбор», сопоставление по ЦФЗ+дате) вёл заказ, где приоритетный
// товар остался не взят. Всё — живые запросы в WMS по браузерному токену,
// как и остальной раздел «Комплектация», без своего бэкенда.
export default function PickingGapsPage() {
  const [dateRange, setDateRange] = useState({ from: todayStr(), to: todayStr() })
  const [temps, setTemps] = useState(() => new Set())
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')

  const [orders, setOrders] = useState(null) // [{ id, address, shipmentNumber, ... , stuckItems: [name] }]
  const [addressToEmployee, setAddressToEmployee] = useState(new Map())
  const [selectedProducts, setSelectedProducts] = useState(() => new Set())
  const [exporting, setExporting] = useState(false)

  // Компания сотрудника — не приходит от WMS (responsibleUser отдаёт только
  // ФИО), берём из своей же базы сотрудников (/api/empl) по executorId
  // (= responsibleUser.id — тот же id, что уже используется во всей
  // статистике проекта для сопоставления исполнителя).
  const [companyByExecutorId, setCompanyByExecutorId] = useState(new Map())
  useEffect(() => {
    api.getEmployees()
      .then(data => {
        const map = new Map()
        for (const e of data.employees || []) {
          if (e.executorId) map.set(e.executorId, e.company || '')
        }
        setCompanyByExecutorId(map)
      })
      .catch(() => setCompanyByExecutorId(new Map()))
  }, [])

  const toggleTemp = value => setTemps(prev => {
    const next = new Set(prev)
    next.has(value) ? next.delete(value) : next.add(value)
    return next
  })

  const load = async () => {
    const token = getStoredToken()
    if (!token) { toast.error('Нет активного WMS-токена — войдите паролем от WMS'); return }
    setLoading(true)
    setError('')
    setOrders(null)
    setSelectedProducts(new Set())
    try {
      const shippedDateFrom = dateToApiFrom(new Date(dateRange.from || todayStr()))
      const shippedDateTo = dateToApiTo(new Date(dateRange.to || dateRange.from || todayStr()))
      const temperatureMode = temps.size ? [...temps] : null

      setProgress('Загружаю список заказов...')
      const pageSize = 100
      const first = await getShipmentOrders(token, { shippedDateFrom, shippedDateTo, status: SHIPMENT_STATUSES, temperatureMode, pageNumber: 1, pageSize })
      const firstValue = first?.value ?? first
      const total = firstValue?.total ?? 0
      let orderList = [...(firstValue?.items ?? [])]
      const pages = Math.ceil(total / pageSize)
      for (let p = 2; p <= pages; p++) {
        const r = await getShipmentOrders(token, { shippedDateFrom, shippedDateTo, status: SHIPMENT_STATUSES, temperatureMode, pageNumber: p, pageSize })
        orderList = orderList.concat((r?.value ?? r)?.items ?? [])
      }

      if (!orderList.length) {
        setOrders([])
        toast.info('Заказов в статусах «Ждёт комплектации»/«Комплектация» за период не найдено')
        setLoading(false)
        return
      }

      setProgress(`Заказов: ${orderList.length}. Загружаю детали (товары)...`)
      const withDetails = []
      for (let i = 0; i < orderList.length; i += DETAIL_BATCH) {
        const batch = orderList.slice(i, i + DETAIL_BATCH)
        const details = await Promise.all(
          batch.map(o => getShipmentOrderDetail(token, o.id).catch(err => ({ _error: err.message })))
        )
        batch.forEach((o, idx) => {
          const d = details[idx]
          if (d?._error) { withDetails.push({ ...o, stuckItems: [], _error: d._error }); return }
          const detail = d?.value ?? d
          const stuckItems = [
            ...(detail?.pieceProducts || [])
              .filter(p => (Number(p.actualQuantity) || 0) < (Number(p.plannedQuantity) || 0))
              .map(p => p.name),
            ...(detail?.weightProducts || [])
              .filter(p => (Number(p.actualWeightInGrams) || 0) < (Number(p.plannedWeightInGrams) || 0))
              .map(p => p.name),
          ]
          withDetails.push({ ...o, stuckItems })
        })
        setProgress(`Загружено деталей: ${withDetails.length} / ${orderList.length}...`)
      }

      // Только ЗАВЕРШЁННЫЕ задания штучного отбора — сотрудник должен реально
      // отчитаться «выполнено» по этому ЦФЗ (а не быть просто назначенным/
      // начавшим), и при этом в заказе остались непобранные товары. Без
      // фильтра по статусу WMS отдаёт все задания (включая ещё не начатые),
      // что и давало посторонних людей в отчёте.
      setProgress('Загружаю сотрудников штучного отбора (для сопоставления по ЦФЗ)...')
      const taskFirst = await getPieceSelectionTasks(token, { dateFrom: shippedDateFrom, dateTo: shippedDateTo, status: ['COMPLETED'], pageNumber: 1, pageSize: 100 })
      const taskFirstValue = taskFirst?.value ?? taskFirst
      const taskTotal = taskFirstValue?.total ?? 0
      let tasks = [...(taskFirstValue?.items ?? [])]
      const taskPages = Math.ceil(taskTotal / 100)
      for (let p = 2; p <= taskPages; p++) {
        const r = await getPieceSelectionTasks(token, { dateFrom: shippedDateFrom, dateTo: shippedDateTo, status: ['COMPLETED'], pageNumber: p, pageSize: 100 })
        tasks = tasks.concat((r?.value ?? r)?.items ?? [])
      }
      const addrMap = new Map()
      for (const t of tasks) {
        const addr = t.shipTo?.name
        if (!addr) continue
        const existing = addrMap.get(addr)
        if (!existing || (t.logisticDate && (!existing.logisticDate || t.logisticDate < existing.logisticDate))) {
          addrMap.set(addr, { responsibleUser: t.responsibleUser, logisticDate: t.logisticDate })
        }
      }

      setOrders(withDetails)
      setAddressToEmployee(addrMap)
      setProgress('')
      toast.success(`Загружено заказов: ${withDetails.length}`)
    } catch (err) {
      toast.error('Ошибка загрузки: ' + err.message)
      setError(err.message || 'Не удалось загрузить данные')
      setOrders([])
    } finally {
      setLoading(false)
      setProgress('')
    }
  }

  // Товар → сколько заказов, где он не побран целиком — глобально по всей
  // загруженной выборке, чтобы пользователь мог выбрать самые проблемные.
  const stuckByProduct = useMemo(() => {
    const map = new Map()
    for (const o of orders || []) {
      for (const name of o.stuckItems || []) {
        if (!map.has(name)) map.set(name, 0)
        map.set(name, map.get(name) + 1)
      }
    }
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'))
  }, [orders])

  const toggleProduct = name => setSelectedProducts(prev => {
    const next = new Set(prev)
    next.has(name) ? next.delete(name) : next.add(name)
    return next
  })

  // Отчёт по сотрудникам: заказы, где среди непобранного есть отмеченный
  // товар, сгруппированные по исполнителю (найден по ЦФЗ заказа среди
  // задач штучного отбора за тот же период). Группируем по executorId, а
  // не только по ФИО — так тёзки из разных компаний не схлопнутся в одного.
  const report = useMemo(() => {
    if (!selectedProducts.size) return []
    const byEmployee = new Map()
    for (const o of orders || []) {
      const missed = (o.stuckItems || []).filter(name => selectedProducts.has(name))
      if (!missed.length) continue
      const match = addressToEmployee.get(o.address)
      const name = match ? userName(match.responsibleUser) : 'Не найден (нет завершённого задания штучного отбора по этому ЦФЗ/дате)'
      const executorId = match?.responsibleUser?.id || ''
      const company = executorId ? (companyByExecutorId.get(executorId) || 'Не найдена') : '—'
      const key = executorId || name
      if (!byEmployee.has(key)) byEmployee.set(key, { name, company, cases: [] })
      byEmployee.get(key).cases.push({ address: o.address, shipmentNumber: o.shipmentNumber, missed })
    }
    return [...byEmployee.values()]
      .sort((a, b) => b.cases.length - a.cases.length || a.name.localeCompare(b.name, 'ru'))
  }, [orders, selectedProducts, addressToEmployee, companyByExecutorId])

  const [expanded, setExpanded] = useState(() => new Set())
  const toggleExpanded = name => setExpanded(prev => {
    const next = new Set(prev)
    next.has(name) ? next.delete(name) : next.add(name)
    return next
  })

  const handleExportExcel = async () => {
    if (!report.length) { toast.info('Нет данных для экспорта'); return }
    setExporting(true)
    try {
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      wb.creator = 'ВС'; wb.created = new Date()
      const ws = wb.addWorksheet('Пропуски в отборе')

      const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
      const BORDER = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
      const ALIGN = { horizontal: 'center', vertical: 'middle' }

      const hdrRow = ws.addRow(['ФИО сотрудника', 'Компания', 'ЦФЗ', '№ отгрузки', 'Пропущенный товар'])
      hdrRow.eachCell(cell => { cell.style = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: HEADER_FILL, border: BORDER, alignment: ALIGN } })
      ws.views = [{ state: 'frozen', ySplit: 1 }]

      for (const emp of report) {
        for (const c of emp.cases) {
          for (const productName of c.missed) {
            const row = ws.addRow([emp.name, emp.company, c.address, c.shipmentNumber, productName])
            row.eachCell({ includeEmpty: true }, cell => { cell.style = { border: BORDER, alignment: { vertical: 'middle', wrapText: true } } })
          }
        }
      }

      ws.getColumn(1).width = 32; ws.getColumn(2).width = 20
      ws.getColumn(3).width = 34; ws.getColumn(4).width = 16; ws.getColumn(5).width = 50

      const buf = await wb.xlsx.writeBuffer()
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Пропуски_в_отборе_${dateRange.from}_${dateRange.to}.xlsx`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success('Файл .xlsx загружен')
    } catch (err) {
      toast.error('Ошибка экспорта: ' + err.message)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Пропуски в отборе</h1>
        <p className="text-sm text-muted-foreground">
          Заказы «{SHIPMENT_ORDER_STATUS_LABELS.WAITING_FOR_PICKING}»/«{SHIPMENT_ORDER_STATUS_LABELS.PICKING}» с несобранными товарами — кто из сотрудников их вёл
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
        <DateRangePicker from={dateRange.from} to={dateRange.to} onChange={setDateRange} placeholder="Период отгрузки" />
        <span className="text-xs text-muted-foreground">Температура:</span>
        {TEMP_OPTIONS.map(t => (
          <button
            key={t.value} type="button" onClick={() => toggleTemp(t.value)}
            className={cn(
              'rounded-md border px-2 py-1 text-xs font-medium transition-colors',
              temps.has(t.value) ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted',
            )}
          >
            {t.label}
          </button>
        ))}
        <span className="text-xs text-muted-foreground">(ничего не выбрано — все режимы)</span>
        <Button onClick={load} disabled={loading} className="ml-auto">
          <RefreshCw className="size-3.5" /> {loading ? 'Загрузка...' : 'Загрузить'}
        </Button>
      </div>

      {error && <div className="text-sm text-destructive">{error}</div>}
      {loading && <Spinner label={progress || 'Загрузка...'} />}

      {orders && !loading && (
        <>
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            <TriangleAlert size={16} className="mt-0.5 shrink-0 text-amber-600" />
            <div className="text-muted-foreground">
              Загружено заказов: <strong className="text-foreground">{orders.length}</strong>. Большой диапазон дат/все температуры
              сразу — детали тянутся по одному заказу, может занимать несколько минут.
            </div>
          </div>

          <div className="rounded-lg border">
            <div className="border-b bg-muted/30 px-3 py-2 text-sm font-medium">
              Шаг 1 — отметьте товары, которые считаете приоритетными (должны отбираться первыми)
            </div>
            {stuckByProduct.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">Непобранных товаров не найдено</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>Товар</TableHead>
                    <TableHead className="text-right">Заказов</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stuckByProduct.map(row => (
                    <TableRow key={row.name} className="cursor-pointer" onClick={() => toggleProduct(row.name)}>
                      <TableCell onClick={e => e.stopPropagation()}>
                        <Checkbox checked={selectedProducts.has(row.name)} onCheckedChange={() => toggleProduct(row.name)} />
                      </TableCell>
                      <TableCell className="whitespace-normal">{row.name}</TableCell>
                      <TableCell className="text-right">{fmtNum(row.count)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <div className="rounded-lg border">
            <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2">
              <div className="text-sm font-medium">Шаг 2 — отчёт по сотрудникам</div>
              <Button size="sm" variant="outline" disabled={exporting || !report.length} onClick={handleExportExcel}>
                <Download className="size-3.5" /> {exporting ? 'Формируем...' : 'Скачать в Excel'}
              </Button>
            </div>
            {!selectedProducts.size ? (
              <div className="p-6 text-center text-sm text-muted-foreground">Отметьте хотя бы один товар в шаге 1</div>
            ) : report.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">Заказов с выбранными товарами в непобранном не найдено</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>ФИО</TableHead>
                    <TableHead>Компания</TableHead>
                    <TableHead className="text-right">Случаев</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.map(emp => {
                    const rowKey = `${emp.name}||${emp.company}`
                    const isOpen = expanded.has(rowKey)
                    return (
                      <Fragment key={rowKey}>
                        <TableRow className="cursor-pointer" onClick={() => toggleExpanded(rowKey)}>
                          <TableCell>{isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</TableCell>
                          <TableCell className="font-medium">{emp.name}</TableCell>
                          <TableCell>{emp.company}</TableCell>
                          <TableCell className="text-right">{emp.cases.length}</TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow>
                            <TableCell colSpan={4} className="whitespace-normal bg-muted/30 p-0">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>ЦФЗ</TableHead>
                                    <TableHead>№ отгрузки</TableHead>
                                    <TableHead>Пропущенные товары</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {emp.cases.map((c, i) => (
                                    <TableRow key={i}>
                                      <TableCell>{c.address}</TableCell>
                                      <TableCell>{c.shipmentNumber}</TableCell>
                                      <TableCell className="whitespace-normal">
                                        <div className="flex flex-wrap gap-1">
                                          {c.missed.map((m, mi) => <Badge key={mi} variant="warning">{m}</Badge>)}
                                        </div>
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        </>
      )}

      {!orders && !loading && (
        <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">Выберите период и нажмите «Загрузить»</div>
      )}
    </div>
  )
}
