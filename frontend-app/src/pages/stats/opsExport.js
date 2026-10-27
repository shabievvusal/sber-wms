// Excel-отчёты по операциям (кроме приёмки — receivingExport.js):
//  • спуск / пополнение / размещение — по строкам журнала stocks/changes
//    (/api/stats/report/{op}); строка = товар, операция = ЕО + сотрудник +
//    время завершения (так же считает статистика на странице);
//  • остатки (объединение) — строка = операция;
//  • комплектация — готовые агрегаты с сервера (строк слишком много).
// Оформление — общее с отчётом приёмки.

import {
  BORDER, DEC1, DT, KG, NUM, PCT, SUBHDR_FILL, TM,
  addTable, avg, durationMin, excelDate, hourLabel, kg, mskHour, round1, titleRows,
} from './receivingExport'

export const OP_META = {
  movedown: { title: 'Спуск', file: 'спуск', keyCell: 'sourceCell', keyCellLabel: 'Ячейка хранения (откуда спускают)', unit: 'операций' },
  refill: { title: 'Пополнение', file: 'пополнение', keyCell: 'targetCell', keyCellLabel: 'Ячейка отбора (куда пополняют)', unit: 'операций' },
  placement: { title: 'Размещение', file: 'размещение', keyCell: 'targetCell', keyCellLabel: 'Ячейка размещения (куда)', unit: 'операций', sources: true },
  remains: { title: 'Остатки (объединение)', file: 'остатки', keyCell: 'sourceCell', keyCellLabel: 'Ячейка (откуда объединяют)', unit: 'операций' },
  selection: { title: 'Комплектация', file: 'комплектация' },
}

const share = (part, whole) => (whole ? part / whole : 0)
const cellZone = cell => (cell || '').split('-')[0] || '—'
const cellRow = cell => (cell || '').split('-').slice(0, 2).join('-') || '—'

// ── строки → операции ────────────────────────────────────────────────────────

// Спуск/пополнение/размещение: строки-товары → операции (ЕО + сотрудник + время).
export function groupMoves(rows) {
  const map = new Map()
  for (const r of rows) {
    const key = `${r.executorId}|${r.sourceHu}|${r.completedAt}`
    let op = map.get(key)
    if (!op) {
      op = {
        shiftDate: r.shiftDate, completedAt: r.completedAt, startedAt: r.startedAt,
        executorId: r.executorId, executor: r.executor, company: r.company,
        sourceCell: r.sourceCell, sourceHu: r.sourceHu, targetCell: r.targetCell, targetHu: r.targetHu,
        positions: 0, qty: 0, grams: 0, noWeight: 0, products: [],
      }
      map.set(key, op)
    }
    op.positions += 1
    op.qty += Number(r.qty) || 0
    if (r.grams == null) op.noWeight += 1
    else op.grams += Number(r.grams) || 0
    op.products.push({ code: r.code, name: r.name, qty: Number(r.qty) || 0, grams: r.grams })
  }
  return [...map.values()].sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt))
}

// Остатки: строка уже операция.
export function remainsOps(rows) {
  return rows.map(r => ({ ...r, startedAt: null, positions: Number(r.positions) || 0, qty: Number(r.qty) || 0, grams: 0, noWeight: 0, products: [] }))
    .sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt))
}

export function aggregateOps(ops, keyFn) {
  const map = new Map()
  for (const o of ops) {
    const key = keyFn(o)
    let a = map.get(key)
    if (!a) {
      a = { key, ops: 0, positions: 0, qty: 0, grams: 0, noWeight: 0, durations: [], executors: new Set(), days: new Set(), hours: new Set(), cells: new Set(), products: new Set(), perDay: new Map(), first: null, last: null, sample: o }
      map.set(key, a)
    }
    a.ops += 1
    a.positions += o.positions
    a.qty += o.qty
    a.grams += o.grams
    a.noWeight += o.noWeight
    const d = durationMin(o)
    if (d != null) a.durations.push(d)
    if (o.executorId || o.executor) a.executors.add(o.executorId || o.executor)
    if (o.shiftDate) {
      a.days.add(o.shiftDate)
      a.perDay.set(o.shiftDate, (a.perDay.get(o.shiftDate) || 0) + 1)
    }
    if (o.completedAt) {
      const t = new Date(o.completedAt).getTime()
      a.hours.add(Math.floor(t / 3_600_000))
      if (a.first == null || t < a.first) a.first = t
      if (a.last == null || t > a.last) a.last = t
    }
    if (o.sourceCell) a.cells.add(o.sourceCell)
    for (const p of o.products) if (p.code) a.products.add(p.code)
  }
  return [...map.values()]
}

async function download(wb, fileName) {
  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

function kpiSheet(wb, title, sub, kpi) {
  const ws = wb.addWorksheet('Сводка')
  titleRows(ws, title, sub, 3)
  const head = ws.addRow(['Показатель', 'Значение'])
  head.eachCell(c => { c.style = { font: { bold: true }, fill: SUBHDR_FILL, border: BORDER } })
  for (const [label, value, fmt] of kpi) {
    const r = ws.addRow([label, value])
    r.getCell(1).border = BORDER
    r.getCell(2).border = BORDER
    r.getCell(2).numFmt = fmt
    r.getCell(2).alignment = { horizontal: 'center' }
    r.getCell(2).font = { bold: true }
  }
  ws.getColumn(1).width = 40
  ws.getColumn(2).width = 16
  return ws
}

// Таблица «сотрудник × час» (count в ячейке), насыщенность — по максимуму.
function matrixSheet(wb, title, sub, hourOrder, executors, valueOf) {
  const ws = wb.addWorksheet('Сотрудник × час')
  const ncols = 2 + hourOrder.length + 1
  titleRows(ws, title, sub, ncols)
  const header = ws.addRow(['Компания', 'Сотрудник', ...hourOrder.map(hourLabel), 'Итого'])
  header.eachCell(c => { c.style = { font: { bold: true }, fill: SUBHDR_FILL, border: BORDER, alignment: { horizontal: 'center' } } })
  const all = executors.flatMap(e => hourOrder.map(h => valueOf(e, h) || 0))
  const max = Math.max(1, ...all)
  for (const e of executors) {
    const vals = hourOrder.map(h => valueOf(e, h) || 0)
    const row = ws.addRow([e.company || '—', e.name || '—', ...vals.map(v => v || null), e.total])
    row.eachCell({ includeEmpty: true }, (cell, i) => {
      cell.border = BORDER
      if (i > 2) cell.alignment = { horizontal: 'center' }
      const v = vals[i - 3]
      if (v) {
        const shade = Math.round(255 - (v / max) * 120).toString(16).padStart(2, '0').toUpperCase()
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${shade}${shade}FF` } }
      }
    })
    row.getCell(ncols).font = { bold: true }
  }
  ws.getColumn(1).width = 18
  ws.getColumn(2).width = 34
  for (let c = 3; c <= ncols; c++) ws.getColumn(c).width = 9
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: header.number }]
}

// ── спуск / пополнение / размещение / остатки ───────────────────────────────

export async function exportMovesXlsx(op, ops, { periodLabel, fileName }) {
  const meta = OP_META[op]
  const isRemains = op === 'remains'
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'ВС'
  wb.created = new Date()
  const sub = `${periodLabel} · выгружено ${new Date().toLocaleString('ru-RU')}`
  // ops не пуст — пустую выгрузку отсекает вызывающий код
  const T = aggregateOps(ops, () => 'all')[0]
  const days = [...new Set(ops.map(o => o.shiftDate).filter(Boolean))].sort()
  const multiDay = days.length > 1
  const keyCell = o => o[meta.keyCell]

  // 1. Сводка
  kpiSheet(wb, `${meta.title} — сводка`, sub, [
    ['Операций (ЕО)', T.ops, NUM],
    ['Позиций (товаров в ЕО)', T.positions, NUM],
    ['Штук', T.qty, NUM],
    ...(isRemains ? [] : [['Вес, кг (по справочнику весов)', kg(T.grams), KG], ['Позиций без веса в справочнике', T.noWeight, NUM]]),
    ['Сотрудников', T.executors.size, NUM],
    ['Операций на сотрудника', round1(share(T.ops, T.executors.size)), DEC1],
    ...(isRemains ? [] : [['Средняя длительность операции, мин', round1(avg(T.durations)), DEC1]]),
    ['Среднее позиций в операции', round1(share(T.positions, T.ops)), DEC1],
    ...(multiDay ? [['Дней в периоде', days.length, NUM], ['Среднее операций в день', round1(share(T.ops, days.length)), DEC1]] : []),
  ])

  // 2. Сотрудники
  const byExec = aggregateOps(ops, o => o.executorId || o.executor || '—')
    .map(a => ({
      company: a.sample.company || '—', name: a.sample.executor || '—', days: a.days.size,
      ops: a.ops, positions: a.positions, qty: a.qty, weight: kg(a.grams), share: share(a.ops, T.ops),
      hours: a.hours.size, perHour: round1(share(a.ops, a.hours.size)), perDay: round1(share(a.ops, a.days.size)),
      avgDuration: round1(avg(a.durations)),
      first: a.first ? excelDate(new Date(a.first).toISOString()) : null,
      last: a.last ? excelDate(new Date(a.last).toISOString()) : null,
      _key: a.key,
    }))
    .sort((a, b) => b.ops - a.ops)
  {
    const ws = wb.addWorksheet('Сотрудники')
    const cols = [
      { header: 'Компания', key: 'company', width: 18 },
      { header: 'Сотрудник', key: 'name', width: 34 },
      ...(multiDay ? [{ header: 'Дней', key: 'days', numFmt: NUM, width: 7 }] : []),
      { header: 'Операций', key: 'ops', numFmt: NUM, width: 10 },
      { header: 'Позиций', key: 'positions', numFmt: NUM, width: 9 },
      { header: 'Штук', key: 'qty', numFmt: NUM, width: 10 },
      ...(isRemains ? [] : [{ header: 'Вес, кг', key: 'weight', numFmt: KG, width: 12 }]),
      { header: 'Доля операций', key: 'share', numFmt: PCT, width: 10 },
      { header: 'Часов с операциями', key: 'hours', numFmt: NUM, width: 10 },
      { header: 'Операций / час', key: 'perHour', numFmt: DEC1, width: 10 },
      ...(multiDay ? [{ header: 'Операций / день', key: 'perDay', numFmt: DEC1, width: 10 }] : []),
      ...(isRemains ? [] : [{ header: 'Ср. длит., мин', key: 'avgDuration', numFmt: DEC1, width: 10 }]),
      { header: 'Первая', key: 'first', numFmt: multiDay ? DT : TM, width: multiDay ? 15 : 9 },
      { header: 'Последняя', key: 'last', numFmt: multiDay ? DT : TM, width: multiDay ? 15 : 10 },
    ]
    titleRows(ws, `${meta.title} — по сотрудникам`, `${sub} · «Часов с операциями» — часы, в которые сотрудник завершил хотя бы одну операцию`, cols.length)
    addTable(ws, cols, byExec, {
      freezeCols: 2,
      total: { company: 'Итого', ops: T.ops, positions: T.positions, qty: T.qty, weight: kg(T.grams), share: 1, avgDuration: round1(avg(T.durations)) },
    })
  }

  // 3. Компании
  {
    const ws = wb.addWorksheet('Компании')
    const data = aggregateOps(ops, o => o.company || '—')
      .map(a => ({ company: a.key, executors: a.executors.size, ops: a.ops, share: share(a.ops, T.ops), positions: a.positions, qty: a.qty, weight: kg(a.grams), perExecutor: round1(share(a.ops, a.executors.size)) }))
      .sort((a, b) => b.ops - a.ops)
    const cols = [
      { header: 'Компания', key: 'company', width: 24 },
      { header: 'Сотрудников', key: 'executors', numFmt: NUM, width: 11 },
      { header: 'Операций', key: 'ops', numFmt: NUM, width: 10 },
      { header: 'Доля', key: 'share', numFmt: PCT, width: 9 },
      { header: 'Позиций', key: 'positions', numFmt: NUM, width: 9 },
      { header: 'Штук', key: 'qty', numFmt: NUM, width: 10 },
      ...(isRemains ? [] : [{ header: 'Вес, кг', key: 'weight', numFmt: KG, width: 12 }]),
      { header: 'Операций на сотрудника', key: 'perExecutor', numFmt: DEC1, width: 12 },
    ]
    titleRows(ws, `${meta.title} — по компаниям`, sub, cols.length)
    addTable(ws, cols, data, { freezeCols: 1, total: { company: 'Итого', executors: T.executors.size, ops: T.ops, share: 1, positions: T.positions, qty: T.qty, weight: kg(T.grams) } })
  }

  // 4. По дням (период)
  if (multiDay) {
    const ws = wb.addWorksheet('По дням')
    const byDay = new Map(aggregateOps(ops, o => o.shiftDate).map(a => [a.key, a]))
    const data = days.map(d => {
      const a = byDay.get(d)
      return { date: new Date(`${d}T00:00:00Z`), ops: a.ops, positions: a.positions, qty: a.qty, weight: kg(a.grams), executors: a.executors.size, perExecutor: round1(share(a.ops, a.executors.size)), avgDuration: round1(avg(a.durations)) }
    })
    const cols = [
      { header: 'Дата смены', key: 'date', numFmt: 'dd.mm.yy', width: 12 },
      { header: 'Операций', key: 'ops', numFmt: NUM, width: 10 },
      { header: 'Позиций', key: 'positions', numFmt: NUM, width: 9 },
      { header: 'Штук', key: 'qty', numFmt: NUM, width: 10 },
      ...(isRemains ? [] : [{ header: 'Вес, кг', key: 'weight', numFmt: KG, width: 12 }]),
      { header: 'Сотрудников', key: 'executors', numFmt: NUM, width: 11 },
      { header: 'Операций на сотрудника', key: 'perExecutor', numFmt: DEC1, width: 12 },
      ...(isRemains ? [] : [{ header: 'Ср. длит., мин', key: 'avgDuration', numFmt: DEC1, width: 10 }]),
    ]
    titleRows(ws, `${meta.title} — по дням`, `${sub} · ночная смена относится к дате её начала (21:00)`, cols.length)
    addTable(ws, cols, data, { freezeCols: 1, total: { date: 'Итого', ops: T.ops, positions: T.positions, qty: T.qty, weight: kg(T.grams), executors: T.executors.size } })
  }

  // 5. По часам
  const hourOrder = [...new Set(ops.filter(o => o.completedAt).map(o => mskHour(o.completedAt)))].sort((a, b) => ((a - 9 + 24) % 24) - ((b - 9 + 24) % 24))
  {
    const ws = wb.addWorksheet('По часам')
    const byHour = new Map(aggregateOps(ops.filter(o => o.completedAt), o => mskHour(o.completedAt)).map(a => [a.key, a]))
    const data = hourOrder.map(h => {
      const a = byHour.get(h)
      return { hour: hourLabel(h), ops: a.ops, positions: a.positions, qty: a.qty, weight: kg(a.grams), executors: a.executors.size, perExecutor: round1(share(a.ops, a.executors.size)) }
    })
    const cols = [
      { header: 'Час', key: 'hour', width: 10 },
      { header: 'Операций', key: 'ops', numFmt: NUM, width: 10 },
      { header: 'Позиций', key: 'positions', numFmt: NUM, width: 9 },
      { header: 'Штук', key: 'qty', numFmt: NUM, width: 10 },
      ...(isRemains ? [] : [{ header: 'Вес, кг', key: 'weight', numFmt: KG, width: 12 }]),
      { header: 'Сотрудников', key: 'executors', numFmt: NUM, width: 11 },
      { header: 'Операций на сотрудника', key: 'perExecutor', numFmt: DEC1, width: 12 },
    ]
    titleRows(ws, `${meta.title} — по часам`, `${sub} · час завершения (МСК); за несколько дней — сумма по часу суток`, cols.length)
    addTable(ws, cols, data, { freezeCols: 1, total: { hour: 'Итого', ops: T.ops, positions: T.positions, qty: T.qty, weight: kg(T.grams), executors: T.executors.size } })
  }

  // 6. Сотрудник × час
  {
    const cnt = new Map()
    for (const o of ops) {
      if (!o.completedAt) continue
      const k = `${o.executorId || o.executor}|${mskHour(o.completedAt)}`
      cnt.set(k, (cnt.get(k) || 0) + 1)
    }
    const execs = byExec.map(e => ({ company: e.company, name: e.name, total: e.ops, key: e._key }))
    matrixSheet(wb, `${meta.title} — сотрудник × час`, `${sub} · в ячейке — операций`, hourOrder, execs, (e, h) => cnt.get(`${e.key}|${h}`))
  }

  // 7. Зоны и ряды (по ключевой ячейке)
  {
    const ws = wb.addWorksheet('Зоны и ряды')
    const cellsByRow = new Map()
    for (const o of ops) {
      const r = cellRow(keyCell(o))
      if (!cellsByRow.has(r)) cellsByRow.set(r, new Set())
      if (keyCell(o)) cellsByRow.get(r).add(keyCell(o))
    }
    const data = aggregateOps(ops, o => cellRow(keyCell(o)))
      .map(a => ({ row: a.key, zone: cellZone(a.key), ops: a.ops, positions: a.positions, qty: a.qty, weight: kg(a.grams), executors: a.executors.size, cells: cellsByRow.get(a.key)?.size || 0, share: share(a.ops, T.ops) }))
      .sort((a, b) => b.ops - a.ops)
    const cols = [
      { header: 'Ряд', key: 'row', width: 12 },
      { header: 'Зона', key: 'zone', width: 8 },
      { header: 'Операций', key: 'ops', numFmt: NUM, width: 10 },
      { header: 'Доля', key: 'share', numFmt: PCT, width: 9 },
      { header: 'Позиций', key: 'positions', numFmt: NUM, width: 9 },
      { header: 'Штук', key: 'qty', numFmt: NUM, width: 10 },
      ...(isRemains ? [] : [{ header: 'Вес, кг', key: 'weight', numFmt: KG, width: 12 }]),
      { header: 'Ячеек', key: 'cells', numFmt: NUM, width: 8 },
      { header: 'Сотрудников', key: 'executors', numFmt: NUM, width: 11 },
    ]
    titleRows(ws, `${meta.title} — зоны и ряды`, `${sub} · по полю «${meta.keyCellLabel}»; ряд — зона и номер ряда (HH-3)`, cols.length)
    addTable(ws, cols, data, { freezeCols: 1 })
  }

  // 8. Ячейки — где операций больше всего (для пополнения: мало места в ячейке отбора)
  {
    const ws = wb.addWorksheet('Ячейки')
    const data = aggregateOps(ops, o => keyCell(o) || '—')
      .map(a => ({
        cell: a.key, ops: a.ops, positions: a.positions, qty: a.qty, products: a.products.size, executors: a.executors.size,
        maxPerDay: Math.max(0, ...a.perDay.values()), avgPerDay: round1(share(a.ops, a.days.size)),
      }))
      .sort((a, b) => b.ops - a.ops)
      .slice(0, 1000)
    const cols = [
      { header: meta.keyCellLabel, key: 'cell', width: 22 },
      { header: 'Операций', key: 'ops', numFmt: NUM, width: 10 },
      { header: 'Макс. за смену/день', key: 'maxPerDay', numFmt: NUM, width: 11 },
      { header: 'В среднем за день', key: 'avgPerDay', numFmt: DEC1, width: 11 },
      { header: 'Позиций', key: 'positions', numFmt: NUM, width: 9 },
      { header: 'Штук', key: 'qty', numFmt: NUM, width: 10 },
      ...(isRemains ? [] : [{ header: 'Товаров', key: 'products', numFmt: NUM, width: 9 }]),
      { header: 'Сотрудников', key: 'executors', numFmt: NUM, width: 11 },
    ]
    const hint = op === 'refill' ? ' · ячейки, которые пополняют по много раз, — кандидаты на увеличение места' : ''
    titleRows(ws, `${meta.title} — ячейки`, `${sub} · топ-1000 по числу операций${hint}`, cols.length)
    addTable(ws, cols, data, { freezeCols: 1 })
  }

  // 9. Товары
  if (!isRemains) {
    const ws = wb.addWorksheet('Товары')
    const map = new Map()
    for (const o of ops) {
      for (const p of o.products) {
        const k = p.code || p.name || '—'
        const a = map.get(k) || { code: p.code || '', name: p.name || '', ops: 0, qty: 0, grams: 0, cells: new Set() }
        a.ops += 1
        a.qty += p.qty
        a.grams += Number(p.grams) || 0
        if (keyCell(o)) a.cells.add(keyCell(o))
        map.set(k, a)
      }
    }
    const data = [...map.values()].map(a => ({ code: a.code, name: a.name, ops: a.ops, qty: a.qty, weight: kg(a.grams), cells: a.cells.size }))
      .sort((a, b) => b.ops - a.ops).slice(0, 1000)
    const cols = [
      { header: 'Артикул', key: 'code', width: 14 },
      { header: 'Товар', key: 'name', width: 50 },
      { header: 'Операций', key: 'ops', numFmt: NUM, width: 10 },
      { header: 'Штук', key: 'qty', numFmt: NUM, width: 10 },
      { header: 'Вес, кг', key: 'weight', numFmt: KG, width: 12 },
      { header: 'Ячеек', key: 'cells', numFmt: NUM, width: 8 },
    ]
    titleRows(ws, `${meta.title} — товары`, `${sub} · топ-1000 по числу операций`, cols.length)
    addTable(ws, cols, data, { freezeCols: 2 })
  }

  // 10. Размещение — откуда (ворота/зона приёмки)
  if (meta.sources) {
    const ws = wb.addWorksheet('Источники')
    const data = aggregateOps(ops, o => o.sourceCell || '—')
      .map(a => ({ source: a.key, ops: a.ops, positions: a.positions, qty: a.qty, weight: kg(a.grams), executors: a.executors.size, avgDuration: round1(avg(a.durations)) }))
      .sort((a, b) => b.ops - a.ops)
    const cols = [
      { header: 'Откуда (ворота/ячейка приёмки)', key: 'source', width: 26 },
      { header: 'Операций', key: 'ops', numFmt: NUM, width: 10 },
      { header: 'Позиций', key: 'positions', numFmt: NUM, width: 9 },
      { header: 'Штук', key: 'qty', numFmt: NUM, width: 10 },
      { header: 'Вес, кг', key: 'weight', numFmt: KG, width: 12 },
      { header: 'Сотрудников', key: 'executors', numFmt: NUM, width: 11 },
      { header: 'Ср. длит., мин', key: 'avgDuration', numFmt: DEC1, width: 10 },
    ]
    titleRows(ws, 'Размещение — источники', sub, cols.length)
    addTable(ws, cols, data, { freezeCols: 1 })
  }

  // 11. Операции построчно
  {
    const ws = wb.addWorksheet('Операции')
    const data = ops.map(o => ({
      completedAt: excelDate(o.completedAt), startedAt: excelDate(o.startedAt), duration: round1(durationMin(o)),
      company: o.company || '—', executor: o.executor || '—',
      source: o.sourceCell || '', hu: o.sourceHu || '', target: o.targetCell || '', ...(isRemains ? { targetHu: o.targetHu || '', taskType: o.taskType || '' } : {}),
      positions: o.positions, qty: o.qty, weight: o.noWeight === o.positions && !isRemains ? null : kg(o.grams),
      products: o.products.map(p => p.name).filter(Boolean).join('; ').slice(0, 300),
    }))
    const cols = [
      { header: 'Завершена', key: 'completedAt', numFmt: DT, width: 15 },
      ...(isRemains ? [] : [{ header: 'Начата', key: 'startedAt', numFmt: DT, width: 15 }, { header: 'Длит., мин', key: 'duration', numFmt: DEC1, width: 9 }]),
      { header: 'Компания', key: 'company', width: 16 },
      { header: 'Сотрудник', key: 'executor', width: 32 },
      { header: 'Откуда', key: 'source', width: 16 },
      { header: isRemains ? 'ЕО-источник' : 'ЕО', key: 'hu', width: 15 },
      { header: 'Куда', key: 'target', width: 16 },
      ...(isRemains ? [{ header: 'ЕО-получатель', key: 'targetHu', width: 15 }, { header: 'Тип задачи', key: 'taskType', width: 16 }] : []),
      { header: 'Позиций', key: 'positions', numFmt: NUM, width: 8 },
      { header: 'Штук', key: 'qty', numFmt: NUM, width: 9 },
      ...(isRemains ? [] : [{ header: 'Вес, кг', key: 'weight', numFmt: KG, width: 11 }, { header: 'Товары', key: 'products', width: 60 }]),
    ]
    titleRows(ws, `${meta.title} — операции`, `${sub} · время — МСК`, cols.length)
    addTable(ws, cols, data, { freezeCols: 1, total: { completedAt: 'Итого', positions: T.positions, qty: T.qty, weight: kg(T.grams) } })
  }

  await download(wb, fileName)
}

// ── комплектация (агрегаты с сервера) ───────────────────────────────────────

export async function exportSelectionXlsx(report, { periodLabel, fileName }) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'ВС'
  wb.created = new Date()
  const sub = `${periodLabel} · выгружено ${new Date().toLocaleString('ru-RU')}`
  const T = report.totals
  const multiDay = (report.days || []).length > 1
  const dt = v => (v ? excelDate(v) : null)

  kpiSheet(wb, 'Комплектация — сводка', sub, [
    ['Сборочных заданий (СЗ)', T.tasks, NUM],
    ['  в т.ч. хранение', T.storageTasks, NUM],
    ['  в т.ч. КДК', T.kdkTasks, NUM],
    ['Штук', T.qty, NUM],
    ['Вес, кг (по справочнику весов)', kg(T.grams), KG],
    ['Сотрудников', T.executors, NUM],
    ['СЗ на сотрудника', round1(share(T.tasks, T.executors)), DEC1],
    ['Товаров (артикулов)', T.products, NUM],
    ['Ячеек', T.cells, NUM],
    ['Товаров без веса в справочнике', (report.missingWeight || []).length, NUM],
    ...(multiDay ? [['Дней в периоде', report.days.length, NUM], ['Среднее СЗ в день', round1(share(T.tasks, report.days.length)), DEC1]] : []),
  ])

  const execRows = (report.executors || []).map(e => ({
    company: e.company || '—', name: e.name || e.key, days: e.days, tasks: e.tasks, storage: e.storageTasks, kdk: e.kdkTasks,
    qty: e.qty, weight: kg(e.grams), share: share(e.tasks, T.tasks), hours: e.activeHours,
    perHour: round1(share(e.tasks, e.activeHours)), perDay: round1(share(e.tasks, e.days)), kgPerHour: kg(share(e.grams, e.activeHours)),
    products: e.products, cells: e.cells, first: dt(e.first), last: dt(e.last), _key: e.key,
  })).sort((a, b) => b.tasks - a.tasks)
  {
    const ws = wb.addWorksheet('Сотрудники')
    const cols = [
      { header: 'Компания', key: 'company', width: 18 },
      { header: 'Сотрудник', key: 'name', width: 34 },
      ...(multiDay ? [{ header: 'Дней', key: 'days', numFmt: NUM, width: 7 }] : []),
      { header: 'СЗ', key: 'tasks', numFmt: NUM, width: 9 },
      { header: 'Хранение', key: 'storage', numFmt: NUM, width: 9 },
      { header: 'КДК', key: 'kdk', numFmt: NUM, width: 8 },
      { header: 'Штук', key: 'qty', numFmt: NUM, width: 10 },
      { header: 'Вес, кг', key: 'weight', numFmt: KG, width: 12 },
      { header: 'Доля СЗ', key: 'share', numFmt: PCT, width: 9 },
      { header: 'Часов с операциями', key: 'hours', numFmt: NUM, width: 10 },
      { header: 'СЗ / час', key: 'perHour', numFmt: DEC1, width: 9 },
      { header: 'кг / час', key: 'kgPerHour', numFmt: KG, width: 10 },
      ...(multiDay ? [{ header: 'СЗ / день', key: 'perDay', numFmt: DEC1, width: 9 }] : []),
      { header: 'Товаров', key: 'products', numFmt: NUM, width: 9 },
      { header: 'Ячеек', key: 'cells', numFmt: NUM, width: 8 },
      { header: 'Первая', key: 'first', numFmt: multiDay ? DT : TM, width: multiDay ? 15 : 9 },
      { header: 'Последняя', key: 'last', numFmt: multiDay ? DT : TM, width: multiDay ? 15 : 10 },
    ]
    titleRows(ws, 'Комплектация — по сотрудникам', `${sub} · «Часов с операциями» — часы, в которые сотрудник завершил хотя бы одну операцию`, cols.length)
    addTable(ws, cols, execRows, { freezeCols: 2, total: { company: 'Итого', tasks: T.tasks, storage: T.storageTasks, kdk: T.kdkTasks, qty: T.qty, weight: kg(T.grams), share: 1 } })
  }

  const simple = (sheet, title, rows, firstCol, extraNote = '') => {
    const ws = wb.addWorksheet(sheet)
    const cols = [
      firstCol,
      { header: 'СЗ', key: 'tasks', numFmt: NUM, width: 9 },
      { header: 'Доля', key: 'share', numFmt: PCT, width: 9 },
      { header: 'Хранение', key: 'storage', numFmt: NUM, width: 9 },
      { header: 'КДК', key: 'kdk', numFmt: NUM, width: 8 },
      { header: 'Штук', key: 'qty', numFmt: NUM, width: 10 },
      { header: 'Вес, кг', key: 'weight', numFmt: KG, width: 12 },
      { header: 'Сотрудников', key: 'executors', numFmt: NUM, width: 11 },
      { header: 'СЗ на сотрудника', key: 'perExecutor', numFmt: DEC1, width: 11 },
    ]
    titleRows(ws, title, sub + extraNote, cols.length)
    addTable(ws, cols, rows.map(r => ({
      [firstCol.key]: r._label, tasks: r.tasks, share: share(r.tasks, T.tasks), storage: r.storageTasks, kdk: r.kdkTasks,
      qty: r.qty, weight: kg(r.grams), executors: r.executors, perExecutor: round1(share(r.tasks, r.executors)),
    })), { freezeCols: 1, total: { [firstCol.key]: 'Итого', tasks: T.tasks, share: 1, storage: T.storageTasks, kdk: T.kdkTasks, qty: T.qty, weight: kg(T.grams), executors: T.executors } })
  }
  simple('Компании', 'Комплектация — по компаниям', (report.companies || []).map(c => ({ ...c, _label: c.key })).sort((a, b) => b.tasks - a.tasks), { header: 'Компания', key: 'company', width: 24 })
  simple('Зоны', 'Комплектация — по зонам', (report.zones || []).map(z => ({ ...z, _label: z.key })).sort((a, b) => b.tasks - a.tasks), { header: 'Зона', key: 'zone', width: 10 }, ' · зона — начало адреса ячейки (HH, SH, ICE, KDM…)')
  if (multiDay) simple('По дням', 'Комплектация — по дням', (report.days || []).map(d => ({ ...d, _label: d.key.split('-').reverse().join('.') })), { header: 'Дата смены', key: 'date', width: 12 }, ' · ночная смена относится к дате её начала (21:00)')
  simple('По часам', 'Комплектация — по часам', (report.hours || []).map(h => ({ ...h, _label: hourLabel(Number(h.key)) })), { header: 'Час', key: 'hour', width: 10 }, ' · час завершения (МСК); за несколько дней — сумма по часу суток')

  {
    const cnt = new Map((report.matrix || []).map(m => [`${m.executor}|${m.hour}`, m.tasks]))
    const execs = execRows.map(e => ({ company: e.company, name: e.name, total: e.tasks, key: e._key }))
    matrixSheet(wb, 'Комплектация — сотрудник × час', `${sub} · в ячейке — СЗ`, report.hourOrder || [], execs, (e, h) => cnt.get(`${e.key}|${h}`))
  }

  {
    const ws = wb.addWorksheet('Товары')
    const cols = [
      { header: 'Артикул', key: 'code', width: 14 },
      { header: 'Товар', key: 'name', width: 50 },
      { header: 'Отборов (СЗ)', key: 'tasks', numFmt: NUM, width: 11 },
      { header: 'Штук', key: 'qty', numFmt: NUM, width: 10 },
      { header: 'Вес, кг', key: 'weight', numFmt: KG, width: 12 },
      { header: 'Ячеек', key: 'cells', numFmt: NUM, width: 8 },
      { header: 'Сотрудников', key: 'executors', numFmt: NUM, width: 11 },
    ]
    titleRows(ws, 'Комплектация — товары', `${sub} · топ-500 по числу отборов`, cols.length)
    addTable(ws, cols, (report.products || []).map(p => ({ code: p.key, name: p.name, tasks: p.tasks, qty: p.qty, weight: kg(p.grams), cells: p.cells, executors: p.executors })), { freezeCols: 2 })
  }

  {
    const ws = wb.addWorksheet('Ячейки')
    const cols = [
      { header: 'Ячейка', key: 'cell', width: 18 },
      { header: 'Зона', key: 'zone', width: 8 },
      { header: 'Отборов (СЗ)', key: 'tasks', numFmt: NUM, width: 11 },
      { header: 'Штук', key: 'qty', numFmt: NUM, width: 10 },
      { header: 'Товаров', key: 'products', numFmt: NUM, width: 9 },
      { header: 'Сотрудников', key: 'executors', numFmt: NUM, width: 11 },
    ]
    titleRows(ws, 'Комплектация — ячейки', `${sub} · топ-500 по числу отборов — самые «горячие» ячейки`, cols.length)
    addTable(ws, cols, (report.cells || []).map(c => ({ cell: c.key, zone: cellZone(c.key), tasks: c.tasks, qty: c.qty, products: c.products, executors: c.executors })), { freezeCols: 1 })
  }

  if ((report.missingWeight || []).length) {
    const ws = wb.addWorksheet('Без веса')
    const cols = [
      { header: 'Артикул', key: 'code', width: 16 },
      { header: 'Товар', key: 'name', width: 50 },
      { header: 'Отборов', key: 'picks', numFmt: NUM, width: 10 },
      { header: 'Штук', key: 'qty', numFmt: NUM, width: 10 },
    ]
    titleRows(ws, 'Комплектация — товары без веса', `${sub} · нет в справочнике весов — их вес не попал в итоги`, cols.length)
    addTable(ws, cols, report.missingWeight, { freezeCols: 2 })
  }

  await download(wb, fileName)
}
