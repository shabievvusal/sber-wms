// Excel-отчёт по приёмке — строится по списку поставок
// (/api/date/:date/receiving/rows), не по готовой сводке: так считаются
// разрезы, которых в сводке нет (компании, поставщики, типы, длительность).
// Листы: Сводка · Приёмщики · Компании · [По дням — для периода] · По часам ·
// Приёмщик × час · Поставщики · Поставки.

import { STATUS_LABELS, TYPE_LABELS } from '@/pages/supplies/constants'

export const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
export const SUBHDR_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1D5DB' } }
const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }
export const BORDER = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }

const MSK_MS = 3 * 60 * 60 * 1000
const toMsk = iso => (iso ? new Date(new Date(iso).getTime() + MSK_MS) : null)
export const mskHour = iso => toMsk(iso)?.getUTCHours()
// дата для Excel: «стеночное» московское время как дата без пояса
export const excelDate = iso => {
  const d = toMsk(iso)
  return d ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds())) : null
}
export const kg = grams => Math.round((Number(grams) || 0) / 10) / 100
export const hourLabel = h => `${String(h).padStart(2, '0')}–${String((h + 1) % 24).padStart(2, '0')}`
// длительность приёмки, мин (начало → завершение); нет начала — null
export const durationMin = r => {
  if (!r.startedAt || !r.completedAt) return null
  const m = (new Date(r.completedAt) - new Date(r.startedAt)) / 60000
  return m >= 0 ? m : null
}

export function aggregate(rows, keyFn) {
  const map = new Map()
  for (const r of rows) {
    const key = keyFn(r)
    let a = map.get(key)
    if (!a) {
      a = { key, deliveries: 0, eo: 0, sku: 0, pieces: 0, grams: 0, discrepancy: 0, durations: [], hours: new Set(), executors: new Set(), days: new Set(), first: null, last: null, sample: r }
      map.set(key, a)
    }
    a.deliveries += 1
    a.eo += Number(r.eo) || 0
    a.sku += Number(r.sku) || 0
    a.pieces += Number(r.pieces) || 0
    a.grams += Number(r.weightGrams) || 0
    if (r.status === 'COMPLETED_WITH_DISCREPANCY') a.discrepancy += 1
    const d = durationMin(r)
    if (d != null) a.durations.push(d)
    if (r.completedAt) {
      const t = new Date(r.completedAt).getTime()
      a.hours.add(Math.floor(t / 3_600_000))
      if (a.first == null || t < a.first) a.first = t
      if (a.last == null || t > a.last) a.last = t
    }
    if (r.executorId || r.executor) a.executors.add(r.executorId || r.executor)
    if (r.shiftDate) a.days.add(r.shiftDate)
  }
  return [...map.values()]
}
export const avg = list => (list.length ? list.reduce((s, x) => s + x, 0) / list.length : null)
export const round1 = v => (v == null ? null : Math.round(v * 10) / 10)

// ── оформление ───────────────────────────────────────────────────────────────

export function titleRows(ws, title, subtitle, ncols) {
  ws.addRow([title])
  ws.mergeCells(1, 1, 1, Math.max(ncols, 1))
  ws.getRow(1).getCell(1).style = { font: { bold: true, size: 13, color: { argb: 'FFFFFFFF' } }, fill: HEADER_FILL, alignment: { vertical: 'middle' } }
  ws.getRow(1).height = 26
  ws.addRow([subtitle])
  ws.mergeCells(2, 1, 2, Math.max(ncols, 1))
  ws.getRow(2).getCell(1).style = { font: { italic: true, color: { argb: 'FF4B5563' } } }
  ws.addRow([])
}

// columns: [{ header, key, width, numFmt }] → таблица с шапкой, итогом,
// автофильтром и закреплённой шапкой; возвращает номер строки шапки.
export function addTable(ws, columns, data, { total = null, freezeCols = 0 } = {}) {
  const headerRow = ws.addRow(columns.map(c => c.header))
  headerRow.eachCell(cell => { cell.style = { font: { bold: true }, fill: SUBHDR_FILL, border: BORDER, alignment: { horizontal: 'center', vertical: 'middle', wrapText: true } } })
  headerRow.height = 30
  for (const item of data) {
    const row = ws.addRow(columns.map(c => item[c.key] ?? null))
    row.eachCell({ includeEmpty: true }, (cell, i) => {
      cell.border = BORDER
      const fmt = columns[i - 1]?.numFmt
      if (fmt) cell.numFmt = fmt
    })
  }
  if (total) {
    const row = ws.addRow(columns.map(c => total[c.key] ?? null))
    row.eachCell({ includeEmpty: true }, (cell, i) => {
      cell.style = { font: { bold: true }, fill: TOTAL_FILL, border: BORDER, numFmt: columns[i - 1]?.numFmt }
    })
  }
  columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width ?? 12 })
  const hr = headerRow.number
  ws.autoFilter = { from: { row: hr, column: 1 }, to: { row: hr + data.length, column: columns.length } }
  ws.views = [{ state: 'frozen', xSplit: freezeCols, ySplit: hr }]
  return hr
}

export const NUM = '#,##0'
export const KG = '#,##0.00'
export const DEC1 = '#,##0.0'
export const PCT = '0.0%'
export const DT = 'dd.mm.yy hh:mm'
export const TM = 'hh:mm'

// ── отчёт ────────────────────────────────────────────────────────────────────

export async function exportReceivingXlsx(rows, { periodLabel, fileName }) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'ВС'
  wb.created = new Date()
  const sub = `${periodLabel} · выгружено ${new Date().toLocaleString('ru-RU')}`

  const totals = aggregate(rows, () => 'all')[0] || { deliveries: 0, eo: 0, sku: 0, pieces: 0, grams: 0, discrepancy: 0, durations: [], executors: new Set() }
  const share = (part, whole) => (whole ? part / whole : 0)
  // Выгрузка за период (у строк есть shiftDate — дата смены) — плюс разрез по дням.
  const days = [...new Set(rows.map(r => r.shiftDate).filter(Boolean))].sort()
  const multiDay = days.length > 1

  // 1. Сводка
  {
    const ws = wb.addWorksheet('Сводка')
    titleRows(ws, 'Приёмка — сводка', sub, 4)
    const kpi = [
      ['Поставок принято', totals.deliveries, NUM],
      ['ЕО', totals.eo, NUM],
      ['SKU (план)', totals.sku, NUM],
      ['Штук (факт)', totals.pieces, NUM],
      ['Вес, кг (факт)', kg(totals.grams), KG],
      ['Приёмщиков', totals.executors.size, NUM],
      ['Поставок с расхождением', totals.discrepancy, NUM],
      ['Доля с расхождением', share(totals.discrepancy, totals.deliveries), PCT],
      ['Средняя длительность приёмки, мин', round1(avg(totals.durations)), DEC1],
      ['Среднее ЕО на поставку', round1(share(totals.eo, totals.deliveries)), DEC1],
      ['Средний вес поставки, кг', kg(share(totals.grams, totals.deliveries)), KG],
      ...(multiDay ? [['Дней в периоде', days.length, NUM], ['Среднее поставок в день', round1(share(totals.deliveries, days.length)), DEC1], ['Средний вес в день, кг', kg(share(totals.grams, days.length)), KG]] : []),
    ]
    const head = ws.addRow(['Показатель', 'Значение'])
    head.eachCell(c => { c.style = { font: { bold: true }, fill: SUBHDR_FILL, border: BORDER } })
    for (const [label, value, fmt] of kpi) {
      const r = ws.addRow([label, value])
      r.getCell(1).border = BORDER
      r.getCell(2).border = BORDER
      r.getCell(2).numFmt = fmt
      r.getCell(2).font = { bold: true }
    }
    ws.addRow([])

    const block = (title, groups, labelFn) => {
      const t = ws.addRow([title])
      t.getCell(1).style = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: HEADER_FILL }
      ws.mergeCells(t.number, 1, t.number, 7)
      const h = ws.addRow(['', 'Поставок', 'Доля', 'ЕО', 'Штук', 'Вес, кг', 'С расхожд.'])
      h.eachCell(c => { c.style = { font: { bold: true }, fill: SUBHDR_FILL, border: BORDER, alignment: { horizontal: 'center' } } })
      for (const g of groups.sort((a, b) => b.deliveries - a.deliveries)) {
        const r = ws.addRow([labelFn(g.key), g.deliveries, share(g.deliveries, totals.deliveries), g.eo, g.pieces, kg(g.grams), g.discrepancy])
        r.eachCell({ includeEmpty: true }, c => { c.border = BORDER })
        ;[NUM, PCT, NUM, NUM, KG, NUM].forEach((f, i) => { r.getCell(i + 2).numFmt = f })
      }
      ws.addRow([])
    }
    block('По типу поставки', aggregate(rows, r => r.type || '—'), k => TYPE_LABELS[k] || k)
    block('По статусу', aggregate(rows, r => r.status || '—'), k => STATUS_LABELS[k] || k)
    ws.getColumn(1).width = 36
    for (let c = 2; c <= 7; c++) ws.getColumn(c).width = 14
  }

  // 2. Приёмщики
  const byExecutor = aggregate(rows, r => r.executorId || r.executor || '—')
    .map(a => {
      const hours = a.hours.size
      return {
        company: a.sample.company || '—',
        name: a.sample.executor || '—',
        days: a.days.size,
        perDay: round1(share(a.deliveries, a.days.size)),
        kgPerDay: kg(share(a.grams, a.days.size)),
        deliveries: a.deliveries,
        eo: a.eo,
        sku: a.sku,
        pieces: a.pieces,
        weight: kg(a.grams),
        weightShare: share(a.grams, totals.grams),
        discrepancy: a.discrepancy,
        hours,
        perHour: round1(share(a.deliveries, hours)),
        eoPerHour: round1(share(a.eo, hours)),
        kgPerHour: kg(share(a.grams, hours)),
        avgDuration: round1(avg(a.durations)),
        first: a.first ? excelDate(new Date(a.first).toISOString()) : null,
        last: a.last ? excelDate(new Date(a.last).toISOString()) : null,
      }
    })
    .sort((a, b) => b.deliveries - a.deliveries || b.weight - a.weight)
  {
    const ws = wb.addWorksheet('Приёмщики')
    const cols = [
      { header: 'Компания', key: 'company', width: 18 },
      { header: 'Приёмщик', key: 'name', width: 34 },
      ...(multiDay ? [{ header: 'Дней', key: 'days', numFmt: NUM, width: 7 }] : []),
      { header: 'Поставок', key: 'deliveries', numFmt: NUM, width: 10 },
      { header: 'ЕО', key: 'eo', numFmt: NUM, width: 9 },
      { header: 'SKU', key: 'sku', numFmt: NUM, width: 9 },
      { header: 'Штук', key: 'pieces', numFmt: NUM, width: 11 },
      { header: 'Вес, кг', key: 'weight', numFmt: KG, width: 13 },
      { header: 'Доля веса', key: 'weightShare', numFmt: PCT, width: 10 },
      { header: 'С расхожд.', key: 'discrepancy', numFmt: NUM, width: 10 },
      ...(multiDay ? [{ header: 'Поставок / день', key: 'perDay', numFmt: DEC1, width: 10 }, { header: 'кг / день', key: 'kgPerDay', numFmt: KG, width: 12 }] : []),
      { header: 'Часов с приёмкой', key: 'hours', numFmt: NUM, width: 10 },
      { header: 'Поставок / час', key: 'perHour', numFmt: DEC1, width: 10 },
      { header: 'ЕО / час', key: 'eoPerHour', numFmt: DEC1, width: 9 },
      { header: 'кг / час', key: 'kgPerHour', numFmt: KG, width: 11 },
      { header: 'Ср. длит. приёмки, мин', key: 'avgDuration', numFmt: DEC1, width: 12 },
      { header: 'Первая', key: 'first', numFmt: multiDay ? DT : TM, width: multiDay ? 15 : 9 },
      { header: 'Последняя', key: 'last', numFmt: multiDay ? DT : TM, width: multiDay ? 15 : 10 },
    ]
    titleRows(ws, 'Приёмка — по приёмщикам', `${sub} · «Часов с приёмкой» — часы, в которые приёмщик завершил хотя бы одну поставку`, cols.length)
    addTable(ws, cols, byExecutor, {
      freezeCols: 2,
      total: {
        company: 'Итого', deliveries: totals.deliveries, eo: totals.eo, sku: totals.sku, pieces: totals.pieces,
        weight: kg(totals.grams), weightShare: 1, discrepancy: totals.discrepancy, avgDuration: round1(avg(totals.durations)),
      },
    })
  }

  // 3. Компании
  {
    const ws = wb.addWorksheet('Компании')
    const data = aggregate(rows, r => r.company || '—')
      .map(a => ({
        company: a.key, executors: a.executors.size, deliveries: a.deliveries, share: share(a.deliveries, totals.deliveries),
        eo: a.eo, sku: a.sku, pieces: a.pieces, weight: kg(a.grams), perExecutor: round1(share(a.deliveries, a.executors.size)),
      }))
      .sort((a, b) => b.deliveries - a.deliveries)
    const cols = [
      { header: 'Компания', key: 'company', width: 24 },
      { header: 'Приёмщиков', key: 'executors', numFmt: NUM, width: 11 },
      { header: 'Поставок', key: 'deliveries', numFmt: NUM, width: 10 },
      { header: 'Доля', key: 'share', numFmt: PCT, width: 9 },
      { header: 'ЕО', key: 'eo', numFmt: NUM, width: 9 },
      { header: 'SKU', key: 'sku', numFmt: NUM, width: 9 },
      { header: 'Штук', key: 'pieces', numFmt: NUM, width: 11 },
      { header: 'Вес, кг', key: 'weight', numFmt: KG, width: 13 },
      { header: 'Поставок на приёмщика', key: 'perExecutor', numFmt: DEC1, width: 12 },
    ]
    titleRows(ws, 'Приёмка — по компаниям', sub, cols.length)
    addTable(ws, cols, data, {
      freezeCols: 1,
      total: { company: 'Итого', executors: totals.executors.size, deliveries: totals.deliveries, share: 1, eo: totals.eo, sku: totals.sku, pieces: totals.pieces, weight: kg(totals.grams) },
    })
  }

  // 3б. По дням — только для выгрузки за период
  if (multiDay) {
    const ws = wb.addWorksheet('По дням')
    const byDay = new Map(aggregate(rows, r => r.shiftDate).map(a => [a.key, a]))
    const data = days.map(d => {
      const a = byDay.get(d)
      return {
        date: new Date(`${d}T00:00:00Z`), deliveries: a.deliveries, eo: a.eo, sku: a.sku, pieces: a.pieces, weight: kg(a.grams),
        executors: a.executors.size, perExecutor: round1(share(a.deliveries, a.executors.size)), discrepancy: a.discrepancy, avgDuration: round1(avg(a.durations)),
      }
    })
    const cols = [
      { header: 'Дата смены', key: 'date', numFmt: 'dd.mm.yy', width: 12 },
      { header: 'Поставок', key: 'deliveries', numFmt: NUM, width: 10 },
      { header: 'ЕО', key: 'eo', numFmt: NUM, width: 9 },
      { header: 'SKU', key: 'sku', numFmt: NUM, width: 9 },
      { header: 'Штук', key: 'pieces', numFmt: NUM, width: 11 },
      { header: 'Вес, кг', key: 'weight', numFmt: KG, width: 13 },
      { header: 'Приёмщиков', key: 'executors', numFmt: NUM, width: 11 },
      { header: 'Поставок на приёмщика', key: 'perExecutor', numFmt: DEC1, width: 12 },
      { header: 'С расхожд.', key: 'discrepancy', numFmt: NUM, width: 10 },
      { header: 'Ср. длит. приёмки, мин', key: 'avgDuration', numFmt: DEC1, width: 12 },
    ]
    titleRows(ws, 'Приёмка — по дням', `${sub} · дата смены: ночная смена относится к дате её начала (21:00)`, cols.length)
    addTable(ws, cols, data, {
      freezeCols: 1,
      total: { date: 'Итого', deliveries: totals.deliveries, eo: totals.eo, sku: totals.sku, pieces: totals.pieces, weight: kg(totals.grams), executors: totals.executors.size, discrepancy: totals.discrepancy, avgDuration: round1(avg(totals.durations)) },
    })
  }

  // 4. По часам (час завершения поставки, МСК; при многодневном периоде —
  // сумма по часу суток)
  const hourOrder = [...new Set(rows.filter(r => r.completedAt).sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt)).map(r => mskHour(r.completedAt)))]
  {
    const ws = wb.addWorksheet('По часам')
    const byHour = new Map(aggregate(rows.filter(r => r.completedAt), r => mskHour(r.completedAt)).map(a => [a.key, a]))
    const data = hourOrder.map(h => {
      const a = byHour.get(h)
      return { hour: hourLabel(h), deliveries: a.deliveries, eo: a.eo, sku: a.sku, pieces: a.pieces, weight: kg(a.grams), executors: a.executors.size, perExecutor: round1(share(a.deliveries, a.executors.size)) }
    })
    const cols = [
      { header: 'Час', key: 'hour', width: 10 },
      { header: 'Поставок', key: 'deliveries', numFmt: NUM, width: 10 },
      { header: 'ЕО', key: 'eo', numFmt: NUM, width: 9 },
      { header: 'SKU', key: 'sku', numFmt: NUM, width: 9 },
      { header: 'Штук', key: 'pieces', numFmt: NUM, width: 11 },
      { header: 'Вес, кг', key: 'weight', numFmt: KG, width: 13 },
      { header: 'Приёмщиков', key: 'executors', numFmt: NUM, width: 11 },
      { header: 'Поставок на приёмщика', key: 'perExecutor', numFmt: DEC1, width: 12 },
    ]
    titleRows(ws, 'Приёмка — по часам', `${sub} · час завершения поставки (МСК); за несколько дней — сумма по часу суток`, cols.length)
    addTable(ws, cols, data, {
      freezeCols: 1,
      total: { hour: 'Итого', deliveries: totals.deliveries, eo: totals.eo, sku: totals.sku, pieces: totals.pieces, weight: kg(totals.grams), executors: totals.executors.size },
    })
  }

  // 5. Приёмщик × час — поставки и ЕО
  {
    const ws = wb.addWorksheet('Приёмщик × час')
    const ncols = 2 + hourOrder.length + 1
    titleRows(ws, 'Приёмка — приёмщик × час', `${sub} · в ячейке: поставок (ЕО)`, ncols)
    const header = ws.addRow(['Компания', 'Приёмщик', ...hourOrder.map(hourLabel), 'Итого'])
    header.eachCell(c => { c.style = { font: { bold: true }, fill: SUBHDR_FILL, border: BORDER, alignment: { horizontal: 'center' } } })
    const cellMap = new Map()
    for (const r of rows) {
      if (!r.completedAt) continue
      const k = `${r.executorId || r.executor}|${mskHour(r.completedAt)}`
      const c = cellMap.get(k) || { d: 0, eo: 0 }
      c.d += 1
      c.eo += Number(r.eo) || 0
      cellMap.set(k, c)
    }
    const executors = aggregate(rows, r => r.executorId || r.executor || '—').sort((a, b) => b.deliveries - a.deliveries)
    const maxCell = Math.max(1, ...[...cellMap.values()].map(c => c.d))
    for (const a of executors) {
      const id = a.sample.executorId || a.sample.executor
      const cells = hourOrder.map(h => cellMap.get(`${id}|${h}`))
      const row = ws.addRow([a.sample.company || '—', a.sample.executor || '—', ...cells.map(c => (c ? `${c.d} (${c.eo})` : '')), `${a.deliveries} (${a.eo})`])
      row.eachCell({ includeEmpty: true }, (cell, i) => {
        cell.border = BORDER
        if (i > 2) cell.alignment = { horizontal: 'center' }
        const c = cells[i - 3]
        // насыщенность ячейки — по числу поставок за час
        if (c) {
          const t = c.d / maxCell
          const shade = Math.round(255 - t * 120).toString(16).padStart(2, '0').toUpperCase()
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${shade}${shade}FF` } }
        }
      })
      row.getCell(ncols).font = { bold: true }
    }
    ws.getColumn(1).width = 18
    ws.getColumn(2).width = 34
    for (let c = 3; c <= ncols; c++) ws.getColumn(c).width = 10
    ws.views = [{ state: 'frozen', xSplit: 2, ySplit: header.number }]
  }

  // 6. Поставщики
  {
    const ws = wb.addWorksheet('Поставщики')
    const data = aggregate(rows, r => r.supplierName || '—')
      .map(a => ({
        supplier: a.key, deliveries: a.deliveries, eo: a.eo, sku: a.sku, pieces: a.pieces, weight: kg(a.grams),
        discrepancy: a.discrepancy, discrepancyShare: share(a.discrepancy, a.deliveries), avgDuration: round1(avg(a.durations)),
      }))
      .sort((a, b) => b.deliveries - a.deliveries)
    const cols = [
      { header: 'Поставщик', key: 'supplier', width: 40 },
      { header: 'Поставок', key: 'deliveries', numFmt: NUM, width: 10 },
      { header: 'ЕО', key: 'eo', numFmt: NUM, width: 9 },
      { header: 'SKU', key: 'sku', numFmt: NUM, width: 9 },
      { header: 'Штук', key: 'pieces', numFmt: NUM, width: 11 },
      { header: 'Вес, кг', key: 'weight', numFmt: KG, width: 13 },
      { header: 'С расхожд.', key: 'discrepancy', numFmt: NUM, width: 10 },
      { header: 'Доля расхожд.', key: 'discrepancyShare', numFmt: PCT, width: 11 },
      { header: 'Ср. длит. приёмки, мин', key: 'avgDuration', numFmt: DEC1, width: 12 },
    ]
    titleRows(ws, 'Приёмка — по поставщикам', sub, cols.length)
    addTable(ws, cols, data, { freezeCols: 1 })
  }

  // 7. Поставки — построчно
  {
    const ws = wb.addWorksheet('Поставки')
    const data = [...rows]
      .sort((a, b) => new Date(a.completedAt || 0) - new Date(b.completedAt || 0))
      .map(r => ({
        completedAt: excelDate(r.completedAt), startedAt: excelDate(r.startedAt), duration: round1(durationMin(r)),
        company: r.company || '—', executor: r.executor || '—', taskNumber: r.taskNumber || '', orderNumber: r.orderNumber || '',
        supplier: r.supplierName || '', type: TYPE_LABELS[r.type] || r.type || '', status: STATUS_LABELS[r.status] || r.status || '',
        eo: Number(r.eo) || 0, sku: Number(r.sku) || 0, pieces: Number(r.pieces) || 0, weight: kg(r.weightGrams),
      }))
    const cols = [
      { header: 'Завершена', key: 'completedAt', numFmt: DT, width: 15 },
      { header: 'Начата', key: 'startedAt', numFmt: DT, width: 15 },
      { header: 'Длит., мин', key: 'duration', numFmt: DEC1, width: 9 },
      { header: 'Компания', key: 'company', width: 16 },
      { header: 'Приёмщик', key: 'executor', width: 32 },
      { header: 'Задание', key: 'taskNumber', width: 14 },
      { header: 'Заказ', key: 'orderNumber', width: 18 },
      { header: 'Поставщик', key: 'supplier', width: 34 },
      { header: 'Тип', key: 'type', width: 24 },
      { header: 'Статус', key: 'status', width: 13 },
      { header: 'ЕО', key: 'eo', numFmt: NUM, width: 7 },
      { header: 'SKU', key: 'sku', numFmt: NUM, width: 7 },
      { header: 'Штук', key: 'pieces', numFmt: NUM, width: 10 },
      { header: 'Вес, кг', key: 'weight', numFmt: KG, width: 12 },
    ]
    titleRows(ws, 'Приёмка — поставки', `${sub} · время — МСК; SKU плановое, штуки и вес — фактические`, cols.length)
    addTable(ws, cols, data, {
      freezeCols: 1,
      total: { completedAt: 'Итого', eo: totals.eo, sku: totals.sku, pieces: totals.pieces, weight: kg(totals.grams) },
    })
  }

  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}
