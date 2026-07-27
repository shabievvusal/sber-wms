import { Fragment, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Pagination } from '@/components/ui/pagination'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { Upload, Download, ChevronDown, ChevronRight, TriangleAlert, ArrowRight } from 'lucide-react'

const PAGE_SIZE = 25

// Температурные режимы CSV задач комплектации (ORDINARY/MEDIUM_COLD/
// LOW_COLD) — русские подписи здесь чисто для UI, соответствие с «Тип
// хранения» файла остатков живёт в backend-dotnet
// (Models/StockConsolidationTemperatureLabels.cs), не дублируем логику
// здесь.
const TEMPERATURE_OPTIONS = [
  { code: 'ORDINARY', label: 'Сухой' },
  { code: 'MEDIUM_COLD', label: 'Средний холод' },
  { code: 'LOW_COLD', label: 'Низкий холод' },
]

function fmt(n) {
  return new Intl.NumberFormat('ru-RU').format(Math.round((n ?? 0) * 100) / 100)
}

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function StockConsolidationPage() {
  const tasksRef = useRef(null)
  const stockRef = useRef(null)
  const [tasksFile, setTasksFile] = useState(null)
  const [stockFile, setStockFile] = useState(null)
  const [temperature, setTemperature] = useState('ORDINARY')
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState(null)
  const [expanded, setExpanded] = useState(() => new Set())
  const [rowFilter, setRowFilter] = useState(() => new Set())
  const [onlySingleItem, setOnlySingleItem] = useState(false)
  const [page, setPage] = useState(1)

  const toggleExpanded = address => setExpanded(prev => {
    const next = new Set(prev)
    next.has(address) ? next.delete(address) : next.add(address)
    return next
  })

  const toggleRowFilter = row => {
    setPage(1)
    setRowFilter(prev => {
      const next = new Set(prev)
      next.has(row) ? next.delete(row) : next.add(row)
      return next
    })
  }

  const handleSubmit = async () => {
    if (!tasksFile || !stockFile) {
      toast.error('Выберите оба файла — задачи комплектации и остатки')
      return
    }
    setLoading(true)
    try {
      const data = await api.uploadStockConsolidationReport(tasksFile, stockFile, temperature)
      setResult(data)
      setExpanded(new Set())
      setRowFilter(new Set())
      setOnlySingleItem(false)
      setPage(1)
      toast.success(`Найдено простаивающих ячеек: ${data.summary.idleCellsCount}`)
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  const temperatureLabel = TEMPERATURE_OPTIONS.find(o => o.code === temperature)?.label || temperature

  const distinctRows = result
    ? [...new Set(result.idleCells.map(c => c.row).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    : []

  const filteredCells = !result
    ? []
    : result.idleCells
      .filter(c => rowFilter.size === 0 || rowFilter.has(c.row))
      .filter(c => !onlySingleItem || c.itemsCount === 1)

  const totalPages = Math.max(1, Math.ceil(filteredCells.length / PAGE_SIZE))
  const pageCells = filteredCells.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const handleExportExcel = async () => {
    if (!filteredCells.length) { toast.info('Нет данных для экспорта'); return }
    setExporting(true)
    try {
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      wb.creator = 'ВС'; wb.created = new Date()
      const ws = wb.addWorksheet('Объединение остатков')

      const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
      const BORDER = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
      const ALIGN = { horizontal: 'center', vertical: 'middle' }

      const NCOLS = 9
      const rowsSuffix = rowFilter.size > 0 ? ` • ряды: ${[...rowFilter].sort().join(', ')}` : ''
      const singleItemSuffix = onlySingleItem ? ' • только 1 товар в ячейке' : ''
      ws.addRow([`Объединение остатков • ${temperatureLabel} • ярус 1${rowsSuffix}${singleItemSuffix}`])
      ws.mergeCells(1, 1, 1, NCOLS)
      ws.getRow(1).getCell(1).style = { font: { bold: true, size: 13, color: { argb: 'FFFFFFFF' } }, fill: HEADER_FILL, alignment: { horizontal: 'left', vertical: 'middle' } }
      ws.getRow(1).height = 26

      const hdrRow = ws.addRow([
        'Ряд', 'Адрес МХ (откуда)', 'Товар', 'Кол-во, шт', 'Вес, кг', 'Объём, л',
        'Куда перенести', 'Уже в ячейке-получателе', 'Комментарий',
      ])
      hdrRow.height = 20
      hdrRow.eachCell(cell => { cell.style = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: HEADER_FILL, border: BORDER, alignment: ALIGN } })
      ws.views = [{ state: 'frozen', ySplit: 2 }]

      for (const cell of filteredCells) {
        const t = onlySingleItem ? cell.suggestedTargetSingleItem : cell.suggestedTarget
        const comment = t?.address
          ? [t.isActive ? 'ячейка активна' : 'ячейка простаивает', t.sameProductAlreadyThere ? 'товар уже там' : null].filter(Boolean).join('; ')
          : (t?.reason || '')
        const existing = (t?.existingItems || [])
          .map(ei => `${ei.product} (${fmt(ei.qtySku)} шт, ${fmt(ei.weightKg)} кг, ${fmt(ei.volumeL)} л)`)
          .join('; ')
        // Вся ячейка переносится одним получателем (WMS объединяет только
        // 1-в-1) — «Куда перенести»/«Уже там»/«Комментарий» одинаковы для
        // всех товаров этой ячейки, поэтому повторяются в каждой строке.
        for (const item of cell.items) {
          const row = ws.addRow([
            cell.row, cell.address, item.product,
            item.qtySku, +item.weightKg.toFixed(2), +item.volumeL.toFixed(2),
            t?.address || '—', existing, comment,
          ])
          row.height = 18
          row.eachCell({ includeEmpty: true }, (c, cn) => { c.style = { border: BORDER, alignment: { ...ALIGN, wrapText: cn === 3 || cn === 8 || cn === 9 } } })
        }
      }

      ws.getColumn(1).width = 8; ws.getColumn(2).width = 18; ws.getColumn(3).width = 40
      ws.getColumn(4).width = 11; ws.getColumn(5).width = 11; ws.getColumn(6).width = 11
      ws.getColumn(7).width = 18; ws.getColumn(8).width = 40; ws.getColumn(9).width = 28

      const buf = await wb.xlsx.writeBuffer()
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url
      a.download = `объединение_остатков_${temperature}_${todayStr()}.xlsx`; a.click()
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
        <h1 className="text-xl font-semibold">Объединение остатков</h1>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="flex flex-col gap-[3px]">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Задачи на комплектацию (CSV)
            </label>
            <Button variant="outline" size="sm" asChild>
              <label className="cursor-pointer">
                <Upload /> {tasksFile ? tasksFile.name : 'Выбрать файл'}
                <input
                  ref={tasksRef} type="file" accept=".csv" className="hidden"
                  onChange={e => setTasksFile(e.target.files?.[0] || null)}
                />
              </label>
            </Button>
          </div>

          <div className="flex flex-col gap-[3px]">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Детализация по остаткам на МХ (Excel)
            </label>
            <Button variant="outline" size="sm" asChild>
              <label className="cursor-pointer">
                <Upload /> {stockFile ? stockFile.name : 'Выбрать файл'}
                <input
                  ref={stockRef} type="file" accept=".xlsx,.xls" className="hidden"
                  onChange={e => setStockFile(e.target.files?.[0] || null)}
                />
              </label>
            </Button>
          </div>

          <div className="flex flex-col gap-[3px]">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Температурный режим
            </label>
            <select
              value={temperature} onChange={e => setTemperature(e.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              {TEMPERATURE_OPTIONS.map(o => <option key={o.code} value={o.code}>{o.label}</option>)}
            </select>
          </div>

          <Button size="sm" disabled={loading} onClick={handleSubmit}>
            {loading ? 'Считаем...' : 'Рассчитать'}
          </Button>

          {result && (
            <Button size="sm" variant="outline" disabled={exporting || !filteredCells.length} onClick={handleExportExcel}>
              <Download /> {exporting ? 'Формируем...' : 'Скачать в Excel'}
            </Button>
          )}
        </CardContent>
      </Card>

      {result && result.temperature.unmappedStorageTypesFound.length > 0 && (
        <Card className="border-amber-500/50 bg-amber-500/10">
          <CardContent className="flex items-start gap-2.5 p-4 text-sm">
            <TriangleAlert size={18} className="mt-0.5 shrink-0 text-amber-600" />
            <div>
              <div className="font-semibold">Не все значения «Тип хранения» распознаны</div>
              <div className="text-muted-foreground">
                В файле остатков встречены значения, не соответствующие выбранному режиму
                («{result.temperature.expectedLabel}») ни одному из известных кодов: {' '}
                <strong>{result.temperature.unmappedStorageTypesFound.join(', ')}</strong>.
                {' '}Строки с такими значениями не учтены в расчёте — проверьте соответствие
                кодов режимов и подписей типа хранения.
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {result && (
        <Card>
          <CardContent className="grid grid-cols-2 gap-3 p-4 text-sm md:grid-cols-5">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Нужные товары</div>
              <div className="text-lg font-semibold">{fmt(result.summary.neededProductsCount)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Активные ячейки</div>
              <div className="text-lg font-semibold">{fmt(result.summary.activeCellsCount)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Простаивающие ячейки</div>
              <div className="text-lg font-semibold text-primary">{fmt(result.summary.idleCellsCount)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Вес к переносу, кг</div>
              <div className="text-lg font-semibold">{fmt(result.summary.totalIdleWeightKg)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Объём к переносу, л</div>
              <div className="text-lg font-semibold">{fmt(result.summary.totalIdleVolumeL)}</div>
            </div>
          </CardContent>
        </Card>
      )}

      {result && (
        <p className="px-1 text-xs text-muted-foreground">
          Объединение рассматривается только среди ячеек 1-го яруса. Рекомендации «Куда перенести»
          ищут получателя в том же ряду, тоже на 1-м ярусе, с учётом вместимости ячейки{' '}
          {fmt(result.cellCapacityAssumption.volumeL)} л / {fmt(result.cellCapacityAssumption.maxWeightKg)} кг
          (единый норматив на все ячейки) — раскройте ячейку в таблице ниже, чтобы их увидеть.
        </p>
      )}

      {result && (
        <Card>
          {distinctRows.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 border-b p-3">
              <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ряд:</span>
              {distinctRows.map(row => (
                <button
                  key={row}
                  type="button"
                  onClick={() => toggleRowFilter(row)}
                  className={cn(
                    'rounded-md border px-2 py-0.5 text-xs font-medium transition-colors',
                    rowFilter.has(row) ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted',
                  )}
                >
                  {row}
                </button>
              ))}
              {rowFilter.size > 0 && (
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setRowFilter(new Set())}>
                  Сбросить
                </Button>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5 border-b p-3">
            <button
              type="button"
              onClick={() => { setPage(1); setOnlySingleItem(v => !v) }}
              className={cn(
                'rounded-md border px-2 py-0.5 text-xs font-medium transition-colors',
                onlySingleItem ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted',
              )}
            >
              Только ячейки с 1 товаром
            </button>
            <span className="text-xs text-muted-foreground">
              — «Куда перенести» тоже пересчитывается: получателем предлагается только ячейка, где тоже ровно 1 товар
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
                <TableHead>Адрес МХ</TableHead>
                <TableHead>Ряд</TableHead>
                <TableHead>Ярус</TableHead>
                <TableHead className="text-right">Позиций</TableHead>
                <TableHead className="text-right">Кол-во, шт</TableHead>
                <TableHead className="text-right">Вес, кг</TableHead>
                <TableHead className="text-right">Объём, л</TableHead>
                <TableHead>Куда перенести</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageCells.map(cell => {
                const isOpen = expanded.has(cell.address)
                const t = onlySingleItem ? cell.suggestedTargetSingleItem : cell.suggestedTarget
                return (
                  <Fragment key={cell.address}>
                    <TableRow className="cursor-pointer" onClick={() => toggleExpanded(cell.address)}>
                      <TableCell>{isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</TableCell>
                      <TableCell className="font-medium">{cell.address}</TableCell>
                      <TableCell>{cell.row || '—'}</TableCell>
                      <TableCell>{cell.tier || '—'}</TableCell>
                      <TableCell className="text-right">{cell.itemsCount}</TableCell>
                      <TableCell className="text-right">{fmt(cell.totalQtySku)}</TableCell>
                      <TableCell className="text-right">{fmt(cell.totalWeightKg)}</TableCell>
                      <TableCell className="text-right">{fmt(cell.totalVolumeL)}</TableCell>
                      <TableCell className="whitespace-normal">
                        {t?.address ? (
                          <div className="flex items-center gap-1.5">
                            <ArrowRight size={13} className="shrink-0 text-muted-foreground" />
                            <span className="font-medium">{t.address}</span>
                            <Badge variant={t.isActive ? 'success' : 'secondary'}>
                              {t.isActive ? 'активна' : 'простаивает'}
                            </Badge>
                            {t.sameProductAlreadyThere && <Badge variant="info">товар уже там</Badge>}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t?.reason || '—'}</span>
                        )}
                      </TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow>
                        <TableCell colSpan={9} className="whitespace-normal bg-muted/30 p-3">
                          {t?.existingItems?.length > 0 && (
                            <div className="mb-3 rounded border bg-background/60 p-2 text-xs text-muted-foreground">
                              <div className="mb-1 font-semibold uppercase tracking-wide">Уже в ячейке {t.address}:</div>
                              {t.existingItems.map((ei, ii) => (
                                <div key={ii} className="flex justify-between gap-2">
                                  <span className="truncate">{ei.product}</span>
                                  <span className="shrink-0">{fmt(ei.qtySku)} шт · {fmt(ei.weightKg)} кг · {fmt(ei.volumeL)} л</span>
                                </div>
                              ))}
                            </div>
                          )}
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Товар</TableHead>
                                <TableHead className="text-right">Кол-во, шт</TableHead>
                                <TableHead className="text-right">Вес, кг</TableHead>
                                <TableHead className="text-right">Объём, л</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {cell.items.map((item, i) => (
                                <TableRow key={i}>
                                  <TableCell className="whitespace-normal">{item.product}</TableCell>
                                  <TableCell className="text-right">{fmt(item.qtySku)}</TableCell>
                                  <TableCell className="text-right">{fmt(item.weightKg)}</TableCell>
                                  <TableCell className="text-right">{fmt(item.volumeL)}</TableCell>
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
          {filteredCells.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">
              {result.idleCells.length === 0
                ? 'Простаивающих ячеек не найдено для этого режима.'
                : 'Нет простаивающих ячеек в выбранных рядах.'}
            </div>
          )}
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t p-3">
              <span className="text-xs text-muted-foreground">
                Ячейки {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filteredCells.length)} из {filteredCells.length}
              </span>
              <Pagination page={page} totalPages={totalPages} onChange={setPage} />
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
