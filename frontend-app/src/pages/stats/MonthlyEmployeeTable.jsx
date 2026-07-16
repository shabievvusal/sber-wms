import { useEffect, useState } from 'react'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { DateRangePicker } from '@/components/ui/date-picker'
import { Table, TableHeader, TableBody, TableRow, TableCell } from '@/components/ui/table'
import { SortableHead } from '@/components/ui/sortable-head'
import { Spinner } from '@/components/ui/spinner'
import { RefreshCw } from 'lucide-react'

const selectClass = 'h-8 rounded-md border border-input bg-transparent px-2 text-sm'
const thCls = 'h-8 px-2 text-[11px]'
const tdCls = 'px-2 py-1.5 text-[13px] whitespace-nowrap'

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}
function monthStartStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}
function fmtDate(d) {
  if (!d) return '—'
  const [y, m, day] = d.split('-')
  return `${day}.${m}.${y}`
}
function fmtWorked(min) {
  if (!min || min <= 0) return '—'
  const totalSec = Math.round(min * 60)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}ч ${m}м ${s}с`
  if (m > 0) return `${m}м ${s}с`
  return `${s}с`
}
function enrichRows(rows) {
  return rows.map(r => {
    const wm = r.workedMinutes || 0
    return {
      ...r,
      szPerHour: wm > 0 ? +(r.total * 60 / wm).toFixed(1) : null,
      szPerMin: wm > 0 ? +(r.total / wm).toFixed(2) : null,
    }
  })
}

const API_BY_OP = {
  selection: (from, to, shift, zone) => api.getMonthlyEmployees(from, to, shift, zone),
  placement: (from, to, shift) => api.getMonthlyPlacementEmployees(from, to, shift),
  receiving: (from, to, shift) => api.getMonthlyReceivingEmployees(from, to, shift),
  remains: (from, to, shift) => api.getMonthlyRemainsEmployees(from, to, shift),
}

// Перенесено из оригинала (MonthlyEmployeeTable.jsx) дословно — вкладка «За
// период» показывает ПЛОСКИЙ список строк «сотрудник × день» (не свёрнутую
// по сотруднику сводку, как было в первом заходе порта), со своими
// собственными датами/сменой/зоной — полностью независима от фильтров
// остальной страницы (даже от чипов компании вверху, как и в оригинале:
// `MonthlyEmployeeTable({ exportRef, operation })` не принимает
// filterCompany вообще), плюс строка средних «Ср.СЗ/СЗ-ч/СЗ-мин» и полный
// XLSX-экспорт через exportRef. Список зон в фильтре — `zoneCatalog`,
// переданный сверху из StatsPage.jsx (собран из уже загруженной сводки дня,
// без хардкода — см. format.js: buildZoneCatalog).
export function MonthlyEmployeeTable({ operation, exportRef, zoneCatalog = [] }) {
  const [dateFrom, setDateFrom] = useState(monthStartStr())
  const [dateTo, setDateTo] = useState(todayStr())
  const [shift, setShift] = useState('')
  const [zone, setZone] = useState('')
  const [rows, setRows] = useState(null)
  const [loadedRange, setLoadedRange] = useState(null)
  const [loading, setLoading] = useState(false)
  const [sortCol, setSortCol] = useState('total')
  const [sortDir, setSortDir] = useState('desc')
  const [error, setError] = useState('')

  const isOperationStats = operation !== 'selection'
  const opLabel = operation === 'placement' ? 'Размещение' : operation === 'receiving' ? 'Приёмка' : operation === 'remains' ? 'Остатки' : 'Производительность'
  const totalLabel = isOperationStats ? 'Итого операций' : 'Итого СЗ'
  const rateHourLabel = isOperationStats ? 'Опер./ч' : 'СЗ/ч'
  const rateMinLabel = isOperationStats ? 'Опер./мин' : 'СЗ/мин'
  const selectedZone = zoneCatalog.find(z => z.key === zone)

  const load = async () => {
    if (!dateFrom || !dateTo) return
    setLoading(true)
    setError('')
    try {
      const res = await API_BY_OP[operation](dateFrom, dateTo, shift || undefined, zone || undefined)
      setRows(enrichRows(res.rows || []))
    } catch (err) {
      setRows([])
      setError(err.message || 'Не удалось загрузить данные')
    }
    setLoadedRange({ from: dateFrom, to: dateTo })
    setLoading(false)
  }

  const toggleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortCol(col); setSortDir(col === 'name' || col === 'company' || col === 'date' ? 'asc' : 'desc') }
  }

  // Оригинал не принимает filterCompany вообще — вкладка «За период»
  // намеренно независима от чипов компаний вверху страницы (сверено с
  // реальной сигнатурой `MonthlyEmployeeTable({ exportRef, operation })`).
  const sorted = rows ? [...rows].sort((a, b) => {
    let va, vb
    if (sortCol === 'date') { va = a.date; vb = b.date }
    else if (sortCol === 'company') { va = a.company; vb = b.company }
    else if (sortCol === 'name') { va = a.name; vb = b.name }
    else if (sortCol === 'szPerHour') { va = a.szPerHour ?? -1; vb = b.szPerHour ?? -1 }
    else if (sortCol === 'szPerMin') { va = a.szPerMin ?? -1; vb = b.szPerMin ?? -1 }
    else if (sortCol === 'worked') { va = a.workedMinutes ?? 0; vb = b.workedMinutes ?? 0 }
    else { va = a.total; vb = b.total }
    if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb, 'ru') : vb.localeCompare(va, 'ru')
    return sortDir === 'asc' ? va - vb : vb - va
  }) : null

  const avg = sorted && sorted.length > 0 ? (() => {
    const n = sorted.length
    const avgTotal = +(sorted.reduce((s, r) => s + r.total, 0) / n).toFixed(1)
    const withHour = sorted.filter(r => r.szPerHour != null)
    const withMin = sorted.filter(r => r.szPerMin != null)
    const avgSzPerHour = withHour.length ? +(withHour.reduce((s, r) => s + r.szPerHour, 0) / withHour.length).toFixed(1) : null
    const avgSzPerMin = withMin.length ? +(withMin.reduce((s, r) => s + r.szPerMin, 0) / withMin.length).toFixed(2) : null
    return { avgTotal, avgSzPerHour, avgSzPerMin }
  })() : null

  const handleExport = async () => {
    if (!sorted?.length) return
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    wb.creator = 'ВС'; wb.created = new Date()
    const ws = wb.addWorksheet('Производительность')

    const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
    const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }
    const AVG_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } }
    const BORDER = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
    const ALIGN = { horizontal: 'center', vertical: 'middle' }

    const zoneLbl = selectedZone ? ` • ${selectedZone.label}` : ''
    const shiftLbl = shift === 'night' ? ' • Ночь' : shift === 'day' ? ' • День' : ''
    const title = `${opLabel} • ${fmtDate(loadedRange?.from)} — ${fmtDate(loadedRange?.to)}${isOperationStats ? '' : zoneLbl}${shiftLbl}`

    const NCOLS = 7
    ws.addRow([title])
    ws.mergeCells(1, 1, 1, NCOLS)
    ws.getRow(1).getCell(1).style = { font: { bold: true, size: 13, color: { argb: 'FFFFFFFF' } }, fill: HEADER_FILL, alignment: { horizontal: 'left', vertical: 'middle' } }
    ws.getRow(1).height = 26

    const avgLabels = [isOperationStats ? 'Ср. оп.' : 'Ср. СЗ', rateHourLabel, rateMinLabel]
    const avgValues = [avg?.avgTotal ?? '', avg?.avgSzPerHour ?? '', avg?.avgSzPerMin ?? '']
    avgLabels.forEach((lbl, i) => {
      const labelCell = ws.getRow(1).getCell(9 + i * 2)
      labelCell.value = lbl
      labelCell.style = { font: { bold: true, size: 11 }, fill: AVG_FILL, border: BORDER, alignment: ALIGN }
      const valCell = ws.getRow(1).getCell(10 + i * 2)
      valCell.value = avgValues[i]
      valCell.style = { font: { bold: true, size: 13 }, fill: AVG_FILL, border: BORDER, alignment: ALIGN }
    })

    const headers = ['Дата', 'Компания', 'ФИО', totalLabel, 'В работе', rateHourLabel, rateMinLabel]
    const hdrRow = ws.addRow(headers)
    hdrRow.height = 20
    hdrRow.eachCell(cell => { cell.style = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: HEADER_FILL, border: BORDER, alignment: ALIGN } })
    ws.views = [{ state: 'frozen', ySplit: 2 }]

    ws.getColumn(9).width = 12; ws.getColumn(10).width = 10
    ws.getColumn(11).width = 12; ws.getColumn(12).width = 10
    ws.getColumn(13).width = 14; ws.getColumn(14).width = 10

    for (const r of sorted) {
      const row = ws.addRow([fmtDate(r.date), r.company || '—', r.name, r.total, fmtWorked(r.workedMinutes), r.szPerHour ?? '', r.szPerMin ?? ''])
      row.height = 18
      row.eachCell({ includeEmpty: true }, (cell, cn) => {
        cell.style = { border: BORDER, alignment: ALIGN, ...(cn >= 4 ? { fill: TOTAL_FILL } : {}) }
      })
    }

    ws.getColumn(1).width = 12; ws.getColumn(2).width = 22; ws.getColumn(3).width = 34
    ws.getColumn(4).width = 12; ws.getColumn(5).width = 11; ws.getColumn(6).width = 10; ws.getColumn(7).width = 10

    const buf = await wb.xlsx.writeBuffer()
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `${operation === 'placement' ? 'размещение' : operation === 'receiving' ? 'приемка' : operation === 'remains' ? 'остатки' : 'производительность'}_${loadedRange?.from}_${loadedRange?.to}${operation === 'selection' && zone ? '_' + zone : ''}.xlsx`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  useEffect(() => { if (exportRef) exportRef.current = handleExport })

  return (
    <div className="space-y-3">
      {error && <div className="text-sm text-destructive">{error}</div>}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Период:</span>
        <DateRangePicker className="h-8" from={dateFrom} to={dateTo} onChange={({ from, to }) => { setDateFrom(from); setDateTo(to) }} />
        <select className={selectClass} value={shift} onChange={e => setShift(e.target.value)}>
          <option value="">Все смены</option>
          <option value="day">День (9–21)</option>
          <option value="night">Ночь (21–9)</option>
        </select>
        {!isOperationStats && (
          <select
            className={selectClass}
            style={selectedZone ? { backgroundColor: selectedZone.light, color: selectedZone.text, borderColor: selectedZone.light } : undefined}
            value={zone} onChange={e => setZone(e.target.value)}
          >
            <option value="">Все зоны</option>
            {zoneCatalog.map(z => <option key={z.key} value={z.key}>{z.label}</option>)}
          </select>
        )}
        <Button size="sm" variant="secondary" onClick={load} disabled={loading || !dateFrom || !dateTo}>
          <RefreshCw className="size-3.5" /> {loading ? 'Загрузка...' : 'Загрузить'}
        </Button>
        {loadedRange && (
          <span className="text-xs text-muted-foreground">
            {fmtDate(loadedRange.from)} — {fmtDate(loadedRange.to)}{rows ? ` · ${rows.length} строк` : ''}
          </span>
        )}
      </div>

      {loading && <Spinner label="Загрузка статистики за период..." />}
      {!loading && rows === null && <div className="p-6 text-center text-sm text-muted-foreground">Выберите период и нажмите «Загрузить»</div>}
      {!loading && rows !== null && (!sorted || sorted.length === 0) && <div className="p-6 text-center text-sm text-muted-foreground">Нет данных за выбранный период</div>}

      {avg && (
        <div className="flex flex-wrap gap-2">
          <div className="flex min-w-20 flex-col items-center rounded-md bg-muted/50 px-3.5 py-1">
            <span className="text-[11px] text-muted-foreground">{isOperationStats ? 'Ср. оп.' : 'Ср. СЗ'}</span>
            <span className="text-base font-semibold">{avg.avgTotal}</span>
          </div>
          <div className="flex min-w-20 flex-col items-center rounded-md bg-muted/50 px-3.5 py-1">
            <span className="text-[11px] text-muted-foreground">{rateHourLabel}</span>
            <span className="text-base font-semibold">{avg.avgSzPerHour ?? '—'}</span>
          </div>
          <div className="flex min-w-20 flex-col items-center rounded-md bg-muted/50 px-3.5 py-1">
            <span className="text-[11px] text-muted-foreground">{rateMinLabel}</span>
            <span className="text-base font-semibold">{avg.avgSzPerMin ?? '—'}</span>
          </div>
        </div>
      )}

      {sorted && sorted.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead label="Дата" sortKey="date" sort={{ key: sortCol, dir: sortDir }} onSort={toggleSort} className={thCls} />
                  <SortableHead label="Компания" sortKey="company" sort={{ key: sortCol, dir: sortDir }} onSort={toggleSort} className={thCls} />
                  <SortableHead label="ФИО" sortKey="name" sort={{ key: sortCol, dir: sortDir }} onSort={toggleSort} className={thCls} />
                  <SortableHead label={totalLabel} sortKey="total" sort={{ key: sortCol, dir: sortDir }} onSort={toggleSort} className={`${thCls} text-right`} />
                  <SortableHead label="В работе" sortKey="worked" sort={{ key: sortCol, dir: sortDir }} onSort={toggleSort} className={`${thCls} text-right`} />
                  <SortableHead label={rateHourLabel} sortKey="szPerHour" sort={{ key: sortCol, dir: sortDir }} onSort={toggleSort} className={`${thCls} text-right`} />
                  <SortableHead label={rateMinLabel} sortKey="szPerMin" sort={{ key: sortCol, dir: sortDir }} onSort={toggleSort} className={`${thCls} text-right`} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className={tdCls}>{fmtDate(r.date)}</TableCell>
                    <TableCell className={`${tdCls} text-muted-foreground`}>{r.company}</TableCell>
                    <TableCell className={`${tdCls} font-medium`}>{r.name}</TableCell>
                    <TableCell className={`${tdCls} text-right`}>{r.total}</TableCell>
                    <TableCell className={`${tdCls} text-right`}>{fmtWorked(r.workedMinutes)}</TableCell>
                    <TableCell className={`${tdCls} text-right`}>{r.szPerHour ?? '—'}</TableCell>
                    <TableCell className={`${tdCls} text-right`}>{r.szPerMin ?? '—'}</TableCell>
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
