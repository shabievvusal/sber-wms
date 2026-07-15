import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { getStoredToken, getInboundTasks, getInboundTaskDetail, getInboundTaskResponsibleUsers, getEoChangeInfo } from '@/lib/wmsFetch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Spinner } from '@/components/ui/spinner'
import { Code128Barcode, schedulePrint } from './Code128Barcode'
import { TYPE_LABELS } from './constants'
import { fmtTime, userName } from './format'
import { Search, Printer, RefreshCw } from 'lucide-react'

const PAGE_SIZE = 100

function eoPickStatus(change, receivedQty) {
  if (!change || change.total === 0 || change.remaining === null) return 'Не в работе'
  if (Number(change.remaining) === 0) return 'Скомплектована'
  const picked = Math.max(0, Number(receivedQty || 0) - Number(change.remaining || 0))
  return `Комплектуется${receivedQty ? ` ${Math.round(picked / receivedQty * 100)}%` : ''}`
}

// Локальные хелперы дат/qty — намеренно НЕ переиспользуют dateToApiFrom/To из
// ./format.js (те принимают Date, а не строку) — в оригинале у этой страницы
// тоже свои копии с другой сигнатурой (строка), тот же приём, что и везде в
// этом разделе (см. PLAN.md, дублирование 1-в-1 с оригиналом).
function todayStr() {
  return new Date().toISOString().slice(0, 10)
}
function dateToApiFrom(dateStr) {
  return new Date(`${dateStr}T00:00:00+03:00`).toISOString()
}
function dateToApiTo(dateStr) {
  return new Date(`${dateStr}T23:59:59.999+03:00`).toISOString()
}
function qty(val) {
  if (val == null) return null
  if (typeof val === 'number') return val
  return val.pieceProducts ?? val.weightProducts ?? null
}

function findProductBarcodeInDetail(detail, barcode) {
  const products = detail?.products || []
  const matches = []
  for (const product of products) {
    const productBarcodes = [product.productBarcode, ...(Array.isArray(product.barcodes) ? product.barcodes : [])].filter(Boolean).map(String)
    if (!productBarcodes.includes(barcode)) continue
    for (const part of product.parts || []) {
      for (const hu of part.handlingUnits || []) {
        const eoBarcode = hu.handlingUnitBarcode || hu.id || ''
        if (!eoBarcode) continue
        matches.push({
          eoBarcode, productName: product.name || '—', productBarcode: product.productBarcode || '',
          quantity: qty(hu.actualQuantity) ?? 0,
        })
      }
    }
  }
  return matches
}

function pickAcceptedUser(responsibleUsers = []) {
  const accepted = responsibleUsers.find(u => u.type === 'ACCEPTANCE_COMPLETED') ?? responsibleUsers.find(u => u.type === 'ACCEPTANCE_STARTED')
  return accepted?.user || null
}

// Перенесено из оригинала (frontend/app/src/pages/picking/EoSearchPage.jsx)
// — поиск ЕО по ШК продукта среди сегодняшних поставок, с печатью Code128
// прямо из браузера. Есть настоящий WMS-токен → реальный поиск (getInboundTasks
// за сегодня → getInboundTaskDetail на каждую поставку → getEoChangeInfo на
// каждое совпадение); без токена — прежний поиск по фиксированному демо-индексу.
export default function EoSearchPage() {
  const [barcode, setBarcode] = useState('')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [searched, setSearched] = useState(false)
  const [progress, setProgress] = useState('')
  const [printValue, setPrintValue] = useState('')

  const openPrintPreview = useCallback(value => {
    if (!value) return
    setPrintValue(value)
    schedulePrint()
  }, [])

  const search = async () => {
    const clean = barcode.trim()
    if (!clean) { setError('Введите ШК продукта'); return }
    setError('')
    setLoading(true)
    setSearched(true)
    const token = getStoredToken()
    if (!token) {
      setError('Нет активного WMS-токена — войдите паролем от WMS')
      setLoading(false)
      return
    }
    setRows([])
    setProgress('Загружаю поставки за сегодня...')
    try {
      const today = todayStr()
      const base = { dateFrom: dateToApiFrom(today), dateTo: dateToApiTo(today), pageSize: PAGE_SIZE }
      const first = await getInboundTasks(token, { ...base, pageNumber: 1 })
      const total = first?.value?.total ?? 0
      let supplies = [...(first?.value?.items ?? [])]
      const pages = Math.ceil(total / PAGE_SIZE)
      if (pages > 1) {
        const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => getInboundTasks(token, { ...base, pageNumber: i + 2 })))
        for (const r of rest) supplies = supplies.concat(r?.value?.items ?? [])
      }

      const found = []
      for (let i = 0; i < supplies.length; i += 1) {
        const supply = supplies[i]
        setProgress(`Проверяю поставки: ${i + 1} из ${supplies.length}`)
        try {
          const detailRes = await getInboundTaskDetail(token, { taskType: supply.type, id: supply.id })
          const detail = detailRes?.value ?? detailRes
          const matches = findProductBarcodeInDetail(detail, clean)
          if (matches.length === 0) continue

          const responsiblePromise = getInboundTaskResponsibleUsers(token, { taskType: supply.type, id: supply.id }).catch(() => null)
          const changeResults = await Promise.all(matches.map(match => getEoChangeInfo(token, match.eoBarcode).catch(() => null)))
          const responsibleRes = await responsiblePromise
          const acceptedUser = pickAcceptedUser(responsibleRes?.value?.responsibleUsers || [])

          matches.forEach((match, index) => {
            const change = changeResults[index]
            const receivedQty = Number(match.quantity) || 0
            found.push({
              id: `${supply.id}-${match.eoBarcode}-${index}`,
              supply, eoBarcode: match.eoBarcode, productName: match.productName, productBarcode: match.productBarcode,
              receivedQty,
              status: eoPickStatus(change, receivedQty),
              remaining: change?.remaining,
              picker: change?.executor,
              acceptedUser,
              lastPickAt: change?.completedAt,
            })
          })
        } catch { /* одна проблемная поставка не должна ломать поиск */ }
      }
      setRows(found)
      setProgress(found.length ? `Найдено ЕО: ${found.length}` : 'Товар не найден в сегодняшних поставках')
    } catch (err) {
      setError(err.message || 'Ошибка поиска')
      setProgress('')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Поиск ЕО</h1>
        <p className="text-sm text-muted-foreground">Введите ШК продукта, чтобы найти его ЕО в сегодняшних поставках</p>
      </div>

      {progress && loading && <div className="text-sm text-muted-foreground">{progress}</div>}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            value={barcode}
            onChange={e => setBarcode(e.target.value.replace(/\s/g, ''))}
            onKeyDown={e => { if (e.key === 'Enter') search() }}
            placeholder="ШК продукта"
          />
        </div>
        <Button onClick={search} disabled={loading}>
          <RefreshCw className="size-3.5" /> {loading ? 'Поиск...' : 'Найти'}
        </Button>
      </div>

      {error && <div className="text-sm text-destructive">{error}</div>}

      <style>{`
        @media print { body.eo-printing #root { display: none !important; } body.eo-printing .eo-print-portal { display: flex !important; } }
        .eo-print-portal { display: none; align-items: center; justify-content: center; height: 100vh; }
      `}</style>
      {createPortal(
        <div className="eo-print-portal">
          {printValue && <Code128Barcode value={printValue} className="h-32 w-80" />}
        </div>,
        document.body
      )}

      <div className="rounded-lg border">
        {loading && <Spinner label="Поиск..." />}
        {!loading && searched && rows.length === 0 && !error && (
          <div className="p-8 text-center text-sm text-muted-foreground">Товар не найден в сегодняшних поставках</div>
        )}
        {!loading && !searched && (
          <div className="p-8 text-center text-sm text-muted-foreground">Введите ШК продукта и нажмите «Найти»</div>
        )}
        {!loading && rows.length > 0 && (
          <>
            {/* Мобильные карточки — до md (768px) */}
            <div className="divide-y md:hidden">
              {rows.map(row => (
                <div key={row.id} className="space-y-1.5 p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{row.productName}</span>
                    <button
                      type="button"
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-sm hover:border-primary"
                      onClick={() => openPrintPreview(row.eoBarcode)}
                      title="Печать barcode 128"
                    >
                      <span>{row.eoBarcode || '—'}</span>
                      <Printer className="size-3.5" />
                    </button>
                  </div>
                  {row.productBarcode && <div className="text-xs text-muted-foreground">ШК {row.productBarcode}</div>}
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <span>{TYPE_LABELS[row.supply.type] || row.supply.type || '—'}</span>
                    <span>Поставка {row.supply.taskNumber || row.supply.id}</span>
                    <span>{row.status}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                    <span>Принято: <span className="text-foreground">{row.receivedQty || '—'}</span></span>
                    <span>Остаток: <span className="text-foreground">{row.remaining ?? '—'}</span></span>
                    <span>Комплектует: <span className="text-foreground">{userName(row.picker)}</span></span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>Последний пик: {fmtTime(row.lastPickAt)}</span>
                    <span>Принял: {userName(row.acceptedUser)}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Десктопная таблица — от md и шире */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Тип поставки</TableHead>
                    <TableHead>Поставка</TableHead>
                    <TableHead>ЕО</TableHead>
                    <TableHead>Статус ЕО</TableHead>
                    <TableHead className="text-right">Принято</TableHead>
                    <TableHead className="text-right">Остаток</TableHead>
                    <TableHead>Комплектует</TableHead>
                    <TableHead>Последний пик</TableHead>
                    <TableHead>Принял</TableHead>
                    <TableHead>Товары</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(row => (
                    <TableRow key={row.id}>
                      <TableCell>{TYPE_LABELS[row.supply.type] || row.supply.type || '—'}</TableCell>
                      <TableCell>{row.supply.taskNumber || row.supply.id}</TableCell>
                      <TableCell>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm hover:border-primary"
                          onClick={() => openPrintPreview(row.eoBarcode)}
                          title="Печать barcode 128"
                        >
                          <span>{row.eoBarcode || '—'}</span>
                          <Printer className="size-3.5" />
                        </button>
                      </TableCell>
                      <TableCell>{row.status}</TableCell>
                      <TableCell className="text-right">{row.receivedQty || '—'}</TableCell>
                      <TableCell className="text-right">{row.remaining ?? '—'}</TableCell>
                      <TableCell>{userName(row.picker)}</TableCell>
                      <TableCell>{fmtTime(row.lastPickAt)}</TableCell>
                      <TableCell>{userName(row.acceptedUser)}</TableCell>
                      <TableCell>
                        <div>{row.productName}</div>
                        {row.productBarcode && <div className="text-xs text-muted-foreground">ШК {row.productBarcode}</div>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
