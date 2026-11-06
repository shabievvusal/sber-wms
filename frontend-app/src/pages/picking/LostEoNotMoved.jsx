// «Поиск потеряшек» → «Не переведены в ЗГЗ»: ЕО, в которых товар уже
// скомплектован (статус PICKED), но ЕО всё ещё лежит в ячейке зоны КДК, а не
// в ЗГЗ. Источник — остатки WMS по зонам из справочника «Ячейки → ЦФЗ»
// (stocks/v2/details по zoneIds), строки — товар в ЕО, сгруппированы по ЕО.
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { getStoredToken, fetchZoneStock } from '@/lib/wmsFetch'
import { runExport } from '@/lib/exportProgress'
import { NUM, addTable, titleRows } from '@/pages/stats/receivingExport'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CloudDownload, Download, Search } from 'lucide-react'

const PICKED = 'PICKED'

export function LostEoNotMoved() {
  const [cellStores, setCellStores] = useState(null) // { zones, byCell }
  const [rows, setRows] = useState(null)             // ЕО
  const [stat, setStat] = useState(null)             // { lines, picked, at }
  const [progress, setProgress] = useState(null)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')

  useEffect(() => {
    api.getCellStores()
      .then(d => setCellStores({ zones: d.zones || [], byCell: new Map((d.cells || []).map(c => [c.address, c.storeName])) }))
      .catch(err => toast.error('Справочник ячеек: ' + err.message))
  }, [])

  const load = async () => {
    const token = getStoredToken()
    if (!token) { toast.error('Нет активного WMS-токена — войдите паролем от WMS'); return }
    const zoneIds = (cellStores?.zones || []).map(z => z.zoneId)
    if (!zoneIds.length) { toast.error('Нет зон КДК: добавьте их в Настройки → «Ячейки → ЦФЗ»'); return }
    setProgress({ done: 0, total: 0 })
    try {
      const lines = await fetchZoneStock(token, zoneIds, setProgress)
      const picked = lines.filter(l => l.status === PICKED && l.eo)
      const byEo = new Map()
      for (const l of picked) {
        const e = byEo.get(l.eo) || { eo: l.eo, cell: l.cell, zone: l.zone, store: cellStores.byCell.get(l.cell) || '—', positions: 0, qty: 0, products: [] }
        e.positions += 1
        e.qty += l.qty
        e.products.push(`${l.name} × ${l.qty}`)
        byEo.set(l.eo, e)
      }
      setRows([...byEo.values()].sort((a, b) => a.cell.localeCompare(b.cell, 'ru', { numeric: true }) || a.eo.localeCompare(b.eo)))
      setStat({ lines: lines.length, picked: picked.length, at: new Date() })
    } catch (err) {
      toast.error('Не удалось загрузить из WMS: ' + (err.message || err))
    } finally {
      setProgress(null)
    }
  }

  // ЕО заказов — 022…, ЕО поставок (паллеты на КДК) — 012…
  const shown = useMemo(() => {
    if (!rows) return []
    const q = query.trim().toLowerCase()
    return rows.filter(r =>
      (kind === 'all' || (kind === 'order' ? r.eo.startsWith('022') : r.eo.startsWith('012')))
      && (!q || r.eo.includes(q) || r.cell.toLowerCase().includes(q) || r.store.toLowerCase().includes(q)))
  }, [rows, query, kind])

  const exportXlsx = () => runExport(`не_в_ЗГЗ_${new Date().toISOString().slice(0, 10)}.xlsx`, async p => {
    const ExcelJS = await p.excel()
    const wb = new ExcelJS.Workbook()
    wb.creator = 'ВС'
    const ws = wb.addWorksheet('Не переведены в ЗГЗ')
    const cols = [
      { header: 'ЕО', key: 'eo', width: 16 },
      { header: 'Ячейка', key: 'cell', width: 12 },
      { header: 'ЦФЗ', key: 'store', width: 24 },
      { header: 'Зона', key: 'zone', width: 14 },
      { header: 'Позиций', key: 'positions', numFmt: NUM, width: 9 },
      { header: 'Штук', key: 'qty', numFmt: NUM, width: 9 },
      { header: 'Товары', key: 'products', width: 80 },
    ]
    titleRows(ws, 'ЕО не переведены в ЗГЗ', `остатки WMS на ${stat.at.toLocaleString('ru-RU')} · статус «скомплектовано», ЕО в ячейке КДК`, cols.length)
    addTable(ws, cols, shown.map(r => ({ ...r, products: r.products.join('; ') })), {
      freezeCols: 1,
      total: { eo: 'Итого', positions: shown.reduce((s, r) => s + r.positions, 0), qty: shown.reduce((s, r) => s + r.qty, 0) },
    })
    await p.save(wb, `не_в_ЗГЗ_${new Date().toISOString().slice(0, 10)}.xlsx`)
  })

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-card p-3 shadow-card">
        <Button size="sm" onClick={load} disabled={!!progress || !cellStores}>
          <CloudDownload className="size-3.5" /> {progress ? 'Загрузка…' : 'Обновить из WMS'}
        </Button>
        <span className="text-xs text-muted-foreground">
          {progress
            ? (progress.total ? `строк ${progress.done.toLocaleString('ru-RU')} из ${progress.total.toLocaleString('ru-RU')}` : 'запрос к WMS…')
            : cellStores
              ? `Зоны: ${cellStores.zones.map(z => z.zoneName || z.zoneId).join(', ') || 'нет — добавьте в Настройки → «Ячейки → ЦФЗ»'}`
              : 'Загрузка справочника ячеек…'}
        </span>
        {rows && (
          <>
            <Select className="ml-auto h-8 w-44" value={kind} onChange={e => setKind(e.target.value)}>
              <option value="all">Все ЕО</option>
              <option value="order">ЕО заказов (022…)</option>
              <option value="supply">ЕО поставок (012…)</option>
            </Select>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input className="h-8 w-52 pl-8" placeholder="ЕО, ячейка или ЦФЗ" value={query} onChange={e => setQuery(e.target.value)} />
            </div>
            <Button size="sm" variant="secondary" onClick={() => exportXlsx().catch(err => toast.error(err.message))} disabled={!shown.length}>
              <Download className="size-3.5" /> Excel
            </Button>
          </>
        )}
      </div>

      {rows && (
        <div className="text-sm">
          ЕО не в ЗГЗ: <span className="font-semibold">{shown.length.toLocaleString('ru-RU')}</span>
          <span className="text-muted-foreground">
            {' '}· позиций {shown.reduce((s, r) => s + r.positions, 0).toLocaleString('ru-RU')}
            {' '}· штук {shown.reduce((s, r) => s + r.qty, 0).toLocaleString('ru-RU')}
            {' '}· на {stat.at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
            {' '}(строк остатков в зонах {stat.lines.toLocaleString('ru-RU')}, скомплектовано {stat.picked.toLocaleString('ru-RU')})
          </span>
        </div>
      )}

      {rows && shown.length > 0 && (
        <div className="max-h-[640px] overflow-auto rounded-2xl border border-line bg-card shadow-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ЕО</TableHead>
                <TableHead>Ячейка</TableHead>
                <TableHead>ЦФЗ</TableHead>
                <TableHead className="text-center">Позиций</TableHead>
                <TableHead className="text-center">Штук</TableHead>
                <TableHead>Товары</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map(r => (
                <TableRow key={r.eo}>
                  <TableCell className="font-mono">{r.eo}</TableCell>
                  <TableCell>{r.cell}</TableCell>
                  <TableCell>{r.store}</TableCell>
                  <TableCell className="text-center">{r.positions}</TableCell>
                  <TableCell className="text-center">{r.qty}</TableCell>
                  <TableCell className="max-w-[520px] truncate text-xs text-muted-foreground" title={r.products.join('\n')}>{r.products.join('; ')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {rows && !shown.length && <div className="rounded-2xl border border-line bg-card p-6 text-center text-sm text-muted-foreground">Все скомплектованные ЕО переведены в ЗГЗ</div>}
    </div>
  )
}
