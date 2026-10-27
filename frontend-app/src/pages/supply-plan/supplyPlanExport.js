// Excel «Графика поставок»: итоги дня в формате делопроизводителей (ДН, дата,
// план/факт/% по поставкам, штукам, весу, SKU), разбивка КДК/хранение ×
// тип хранения, список заказов с фактом и поставки вне графика.

import { BORDER, DT, HEADER_FILL, KG, NUM, PCT, SUBHDR_FILL, addTable, excelDate, titleRows } from '@/pages/stats/receivingExport'
import { SUPPLY_GROUPS, pct, storageKeys } from './supplyPlanCalc'

const STATUS_LABEL = { accepted: 'Принята', discrepancy: 'С расхождением', notVerified: 'Не проверена', inProgress: 'Не принята', cancelled: 'Отменена', missing: 'Нет в WMS', extra: 'Вне графика' }
const METRICS = [['count', 'кол-во поставок', NUM], ['pieces', 'штуки', NUM], ['weightKg', 'вес, кг', KG], ['sku', 'SKU', NUM]]
const ZERO = { count: 0, pieces: 0, weightKg: 0, sku: 0 }

export async function exportSupplyPlanXlsx({ date, weekday, plan, planSum, recon, factSum, forecast }) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'ВС'
  wb.created = new Date()
  const dateLbl = date.split('-').reverse().join('.')
  const hasFact = !!factSum

  // 1. Итоги
  {
    const ws = wb.addWorksheet('Итоги')
    titleRows(ws, `График поставок — ${weekday} ${dateLbl}`, hasFact ? `план и факт приёмки (сверка с WMS ${recon.at.toLocaleString('ru-RU')})` : 'план приёмки', 14)

    // строка дня, как в накопительной «статистике»
    const head = ['ДН', 'Дата']
    for (const [, label] of METRICS) head.push(label, hasFact ? 'факт' : '', '%')
    const hr = ws.addRow(head)
    hr.eachCell(c => { c.style = { font: { bold: true }, fill: SUBHDR_FILL, border: BORDER, alignment: { horizontal: 'center' } } })
    const vals = [weekday, dateLbl]
    for (const [k] of METRICS) {
      const p = planSum.total[k]
      const f = hasFact ? factSum.total[k] : null
      vals.push(p, f, f != null ? pct(f, p) : null)
    }
    const vr = ws.addRow(vals)
    vr.eachCell({ includeEmpty: true }, (c, i) => {
      c.border = BORDER
      if (i > 2) c.numFmt = (i - 3) % 3 === 2 ? PCT : (METRICS[Math.floor((i - 3) / 3)]?.[2] || NUM)
    })
    ws.addRow([])

    // разбивка КДК / хранение × тип хранения
    for (const g of SUPPLY_GROUPS) {
      const pg = planSum.groups[g.key]
      if (!pg) continue
      const fg = factSum?.groups[g.key]
      const t = ws.addRow([g.label])
      ws.mergeCells(t.number, 1, t.number, hasFact ? 13 : 5)
      t.getCell(1).style = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: HEADER_FILL }
      const h = ['']
      for (const [, label] of METRICS) hasFact ? h.push(`${label} план`, 'факт', '%') : h.push(label)
      const hrow = ws.addRow(h)
      hrow.eachCell(c => { c.style = { font: { bold: true }, fill: SUBHDR_FILL, border: BORDER, alignment: { horizontal: 'center', wrapText: true } } })
      const line = (label, p, f, bold) => {
        const v = [label]
        for (const [k] of METRICS) hasFact ? v.push(p[k], f[k], pct(f[k], p[k])) : v.push(p[k])
        const r = ws.addRow(v)
        r.eachCell({ includeEmpty: true }, (c, i) => {
          c.border = BORDER
          if (bold) c.font = { bold: true }
          if (i > 1) {
            const mi = hasFact ? Math.floor((i - 2) / 3) : i - 2
            c.numFmt = hasFact && (i - 2) % 3 === 2 ? PCT : METRICS[mi][2]
          }
        })
      }
      line('Всего', pg.totals, fg?.totals || ZERO, true)
      for (const st of storageKeys({ ...pg.byStorage, ...(fg?.byStorage || {}) })) line(st, pg.byStorage[st] || ZERO, fg?.byStorage[st] || ZERO, false)
      ws.addRow([])
    }

    if (forecast?.ok) {
      const r = ws.addRow([`Прогноз СЗ КДК: ~${forecast.value} (${forecast.x} ${forecast.metric.label} × ${forecast.k.toFixed(2)}, по ${forecast.days} дням, ошибка ±${Math.round(forecast.err * 100)}%)`])
      r.getCell(1).font = { bold: true }
    }
    ws.getColumn(1).width = 22
    for (let c = 2; c <= 14; c++) ws.getColumn(c).width = 13
  }

  // 2. Заказы
  {
    const ws = wb.addWorksheet('Заказы')
    const rows = (recon ? recon.rows : plan.map(r => ({ ...r, status: null }))).map(r => ({
      supplier: r.supplier, orderNumber: r.orderNumber, docType: r.docType, supplyType: r.supplyType, storageType: r.storageType,
      sku: r.sku, pieces: r.pieces, weight: r.weightKg,
      factSku: r.fact?.sku ?? null, factPieces: r.fact?.pieces ?? null, factWeight: r.fact?.weightKg ?? null,
      diffPieces: r.fact && r.pieces ? pct(r.fact.pieces, r.pieces) : null,
      status: r.status ? STATUS_LABEL[r.status] : '', gate: r.gate || '', completedAt: excelDate(r.completedAt),
    }))
    const cols = [
      { header: 'Поставщик', key: 'supplier', width: 40 },
      { header: 'Номер заказа', key: 'orderNumber', width: 18 },
      { header: 'Документооборот', key: 'docType', width: 11 },
      { header: 'Тип поставки', key: 'supplyType', width: 14 },
      { header: 'Тип хранения', key: 'storageType', width: 15 },
      { header: 'SKU план', key: 'sku', numFmt: NUM, width: 9 },
      { header: 'Штук план', key: 'pieces', numFmt: NUM, width: 11 },
      { header: 'Вес план, кг', key: 'weight', numFmt: KG, width: 12 },
      ...(hasFact ? [
        { header: 'SKU факт', key: 'factSku', numFmt: NUM, width: 9 },
        { header: 'Штук факт', key: 'factPieces', numFmt: NUM, width: 11 },
        { header: 'Вес факт, кг', key: 'factWeight', numFmt: KG, width: 12 },
        { header: 'Штук, %', key: 'diffPieces', numFmt: PCT, width: 9 },
        { header: 'Статус', key: 'status', width: 15 },
        { header: 'Ворота', key: 'gate', width: 8 },
        { header: 'Завершена в WMS', key: 'completedAt', numFmt: DT, width: 15 },
      ] : []),
    ]
    titleRows(ws, `График поставок — заказы ${dateLbl}`, hasFact ? 'план и факт по номеру заказа' : 'план', cols.length)
    addTable(ws, cols, rows, { freezeCols: 2, total: { supplier: 'Итого', sku: planSum.total.sku, pieces: planSum.total.pieces, weight: planSum.total.weightKg } })
  }

  // 3. Вне графика
  if (recon?.extra?.length) {
    const ws = wb.addWorksheet('Вне графика')
    const cols = [
      { header: 'Поставщик', key: 'supplier', width: 40 },
      { header: 'Номер заказа', key: 'orderNumber', width: 18 },
      { header: 'Тип поставки', key: 'supplyType', width: 14 },
      { header: 'SKU', key: 'sku', numFmt: NUM, width: 9 },
      { header: 'Штук', key: 'pieces', numFmt: NUM, width: 11 },
      { header: 'Вес, кг', key: 'weight', numFmt: KG, width: 12 },
      { header: 'Ворота', key: 'gate', width: 8 },
      { header: 'Принята', key: 'completedAt', numFmt: DT, width: 15 },
    ]
    titleRows(ws, `Принято вне графика — смены ${dateLbl}`, 'задания WMS, которых нет в графике на эту дату', cols.length)
    addTable(ws, cols, recon.extra.map(e => ({
      supplier: e.supplier, orderNumber: e.orderNumber, supplyType: e.supplyType === 'CROSSDOCK' ? 'Кросс-докинг' : 'Хранение',
      sku: e.fact.sku, pieces: e.fact.pieces, weight: e.fact.weightKg, gate: e.gate, completedAt: excelDate(e.completedAt),
    })), { freezeCols: 1 })
  }

  const buf = await wb.xlsx.writeBuffer()
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `график_поставок_${date}.xlsx`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
