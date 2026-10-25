import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableHeader, TableBody, TableRow, TableCell } from '@/components/ui/table'
import { SortableHead } from '@/components/ui/sortable-head'
import { Download, ScanBarcode, X } from 'lucide-react'
import { DT, NUM, addTable, excelDate, titleRows } from '@/pages/stats/receivingExport'

const thCls = 'h-8 px-2 text-[11px]'
const tdCls = 'px-2 py-1.5 text-[13px] whitespace-nowrap'
const fmtDt = iso => (iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')

// Колонки: key — поле строки, text — сортировка по алфавиту.
const COLUMNS = {
  product: [
    { key: 'sourceCell', label: 'Ячейка КДК', text: true },
    { key: 'store', label: 'ЦФЗ', text: true },
    { key: 'targetCell', label: 'Ячейка ЗГЗ', text: true },
    { key: 'hu', label: 'ЕО', text: true },
    { key: 'qty', label: 'Штук' },
    { key: 'completedAt', label: 'Перевод в ЗГЗ', date: true },
    { key: 'executor', label: 'Кто переводил', text: true },
  ],
  cell: [
    { key: 'completedAt', label: 'Перевод в ЗГЗ', date: true },
    { key: 'name', label: 'Товар', text: true },
    { key: 'barcode', label: 'Штрихкод', text: true },
    { key: 'qty', label: 'Штук' },
    { key: 'hu', label: 'ЕО', text: true },
    { key: 'sourceCell', label: 'Ячейка КДК', text: true },
    { key: 'targetCell', label: 'Ячейка ЗГЗ', text: true },
    { key: 'store', label: 'ЦФЗ', text: true },
    { key: 'executor', label: 'Кто переводил', text: true },
  ],
}

// Режимы «По товару» и «По ячейке» страницы «Поиск потеряшек»: таблица по
// выгрузке переводов в ЗГЗ за выбранный период с сортировкой и Excel.
//  • по товару — куда за период кидали этот товар (ячейки КДК/ЗГЗ, ЦФЗ, ЕО,
//    штуки): видно, где не хватает или куда положили лишний;
//  • по ячейке — что кидали в ячейку КДК или ЗГЗ (точный адрес; если такого
//    нет — все ячейки, начинающиеся с введённого, например «KDH-4»).
export function LostEoLookup({ mode, index, cellStores, resolveBarcode, periodLabel }) {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState(null) // product: { productIds, name, code } | cell: { cell }
  const [sort, setSort] = useState(mode === 'cell' ? { key: 'completedAt', dir: 'desc' } : { key: 'sourceCell', dir: 'asc' })
  const inputRef = useRef(null)
  const columns = COLUMNS[mode]

  const submit = e => {
    e.preventDefault()
    const raw = input.trim()
    setInput('')
    if (!raw) return
    if (mode === 'product') {
      const found = resolveBarcode(index, raw)
      if (!found) { toast.error(`Штрихкод ${raw} не найден в переводах в ЗГЗ за выбранный период`); return }
      setQuery({ productIds: found.productIds, name: found.name, code: found.code })
    } else {
      setQuery({ cell: raw.toUpperCase() })
    }
  }

  const rows = useMemo(() => {
    if (!query) return []
    const out = []
    if (mode === 'product') {
      for (const hu of index.hus.values()) {
        let qty = 0
        for (const id of query.productIds) qty += hu.items.get(id)?.qty || 0
        if (qty > 0) out.push({ hu: hu.hu, sourceCell: hu.sourceCell, targetCell: hu.targetCell, store: cellStores.get(hu.sourceCell) || '', qty, completedAt: hu.completedAt, executor: hu.executor })
      }
      return out
    }
    const q = query.cell
    const all = [...index.hus.values()]
    let hus = all.filter(h => h.sourceCell?.toUpperCase() === q || h.targetCell?.toUpperCase() === q)
    if (!hus.length) hus = all.filter(h => h.sourceCell?.toUpperCase().startsWith(q) || h.targetCell?.toUpperCase().startsWith(q))
    for (const hu of hus) {
      for (const it of hu.items.values()) {
        out.push({ completedAt: hu.completedAt, name: it.name || it.code, barcode: it.barcodes[0] || '', qty: it.qty, hu: hu.hu, sourceCell: hu.sourceCell, targetCell: hu.targetCell, store: cellStores.get(hu.sourceCell) || '', executor: hu.executor })
      }
    }
    return out
  }, [query, mode, index, cellStores])

  const sorted = useMemo(() => {
    const col = columns.find(c => c.key === sort.key)
    return [...rows].sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key]
      const cmp = col?.text
        ? String(av ?? '').localeCompare(String(bv ?? ''), 'ru', { numeric: true })
        : col?.date ? new Date(av || 0) - new Date(bv || 0) : (Number(av) || 0) - (Number(bv) || 0)
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [rows, sort, columns])

  const handleSort = key => setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: columns.find(c => c.key === key)?.date ? 'desc' : 'asc' }))

  const totalQty = rows.reduce((s, r) => s + (Number(r.qty) || 0), 0)
  const distinct = key => new Set(rows.map(r => r[key]).filter(Boolean)).size
  const title = mode === 'product' ? `Товар: ${query?.name || query?.code || ''}` : `Ячейка: ${query?.cell || ''}`

  const exportXlsx = async () => {
    if (!sorted.length) return
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    wb.creator = 'ВС'
    wb.created = new Date()
    const ws = wb.addWorksheet(mode === 'product' ? 'По товару' : 'По ячейке')
    const cols = columns.map(c => ({
      header: c.label, key: c.key,
      numFmt: c.date ? DT : c.text ? undefined : NUM,
      width: c.key === 'name' ? 50 : c.key === 'store' ? 34 : c.key === 'executor' ? 30 : c.date ? 15 : 14,
    }))
    titleRows(ws, `Поиск потеряшек — ${title}`, `${periodLabel} · строк ${sorted.length} · штук ${totalQty} · выгружено ${new Date().toLocaleString('ru-RU')}`, cols.length)
    addTable(ws, cols, sorted.map(r => ({ ...r, completedAt: excelDate(r.completedAt) })), { freezeCols: 1, total: { [cols[0].key]: 'Итого', qty: totalQty } })
    const buf = await wb.xlsx.writeBuffer()
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `потеряшки_${mode === 'product' ? (query.code || 'товар') : query.cell}.xlsx`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-card p-3 shadow-card">
        <ScanBarcode className="size-5 text-muted-foreground" />
        <Input
          ref={inputRef}
          autoFocus
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={mode === 'product' ? 'Сканируйте штрихкод товара' : 'Введите ячейку: KDH-4-8, ZGH-4-8 или KDH-4'}
          className="h-10 max-w-sm text-base"
        />
        <Button type="submit" variant="secondary">Показать</Button>
        {query && (
          <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs">
            <span className="max-w-80 truncate" title={title}>{title}</span>
            <button type="button" className="opacity-60 hover:opacity-100" onClick={() => { setQuery(null); inputRef.current?.focus() }}><X className="size-3.5" /></button>
          </span>
        )}
        {sorted.length > 0 && (
          <Button type="button" variant="outline" className="ml-auto" onClick={exportXlsx}><Download className="size-4" /> Excel</Button>
        )}
      </form>

      {query && rows.length === 0 && (
        <div className="p-6 text-center text-sm text-muted-foreground">
          {mode === 'product' ? 'Этот товар за выбранный период в ЗГЗ не переводили' : 'В эту ячейку за выбранный период ничего не переводили'}
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            {mode === 'product'
              ? <>
                  <span>Ячеек КДК: <b>{distinct('sourceCell')}</b></span>
                  <span>ЦФЗ: <b>{distinct('store')}</b></span>
                  <span>ЕО: <b>{distinct('hu')}</b></span>
                  <span>Штук всего: <b>{totalQty}</b></span>
                </>
              : <>
                  <span>ЕО: <b>{distinct('hu')}</b></span>
                  <span>Товаров: <b>{distinct('name')}</b></span>
                  <span>Штук всего: <b>{totalQty}</b></span>
                  {distinct('sourceCell') > 1 && <span>Ячеек: <b>{distinct('sourceCell')}</b></span>}
                </>}
          </div>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  {columns.map(c => <SortableHead key={c.key} label={c.label} sortKey={c.key} sort={sort} onSort={handleSort} className={thCls} />)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((r, i) => (
                  <TableRow key={`${r.hu}-${r.name || ''}-${i}`}>
                    {columns.map(c => (
                      <TableCell key={c.key} className={`${tdCls} ${c.text || c.date ? '' : 'text-right tabular-nums'} ${c.key === 'hu' || c.key === 'barcode' ? 'font-mono text-xs' : ''}`}>
                        {c.date ? fmtDt(r[c.key]) : (r[c.key] || (c.text ? '—' : r[c.key]))}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  )
}
