// Накопительный отчёт по поставкам за период — как ведут делопроизводители:
// лист «статистика» (строка на день: ДН, дата, план/факт/% по поставкам,
// штукам, весу, SKU), лист на каждый день со списком заказов и рейтинг
// поставщиков. Данные — график + сохранённые сверки с WMS (supplyPlanCalc.js).

import { BORDER, DT, KG, NUM, PCT, SUBHDR_FILL, addTable, excelDate, titleRows } from '@/pages/stats/receivingExport'
import { dayStats, pct, supplierRating } from './supplyPlanCalc'

const WEEKDAYS = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ']
const STATUS_LABEL = { accepted: 'Принята', discrepancy: 'С расхождением', notVerified: 'Не проверена', inProgress: 'Не принята', cancelled: 'Отменена', missing: 'Нет в WMS', extra: 'Вне графика' }
const METRICS = [['count', 'кол-во поставок', NUM], ['pieces', 'штуки', NUM], ['weightKg', 'вес, кг', KG], ['sku', 'SKU', NUM]]
const WMS_STORAGE = { ORDINARY: 'Сухой', MEDIUM_COLD: 'Средний холод', LOW_COLD: 'Низкий холод' }
const fmtD = d => d.split('-').reverse().join('.')
const weekday = d => WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]

export const RATING_COLUMNS = [
  { header: 'Поставщик', key: 'supplier', width: 44 },
  { header: 'Заказов в графике', key: 'planned', numFmt: NUM, width: 11 },
  { header: 'Принято', key: 'accepted', numFmt: NUM, width: 10 },
  { header: 'С расхождением', key: 'discrepancy', numFmt: NUM, width: 12 },
  { header: 'Не принята', key: 'waiting', numFmt: NUM, width: 10 },
  { header: 'Отменена', key: 'cancelled', numFmt: NUM, width: 10 },
  { header: 'Не приехала', key: 'notArrived', numFmt: NUM, width: 10 },
  { header: 'Не приехала, %', key: 'notArrivedPct', numFmt: PCT, width: 11 },
  { header: 'Штук по плану (принятые)', key: 'planPieces', numFmt: NUM, width: 13 },
  { header: 'Штук факт', key: 'factPieces', numFmt: NUM, width: 12 },
  { header: 'Недовоз, %', key: 'shortfall', numFmt: PCT, width: 10 },
  { header: 'Вне графика', key: 'extra', numFmt: NUM, width: 10 },
  { header: 'Штук вне графика', key: 'extraPieces', numFmt: NUM, width: 12 },
]

export function addRatingSheet(wb, rating, periodLabel) {
  const ws = wb.addWorksheet('Рейтинг поставщиков')
  titleRows(ws, `Рейтинг поставщиков — ${periodLabel}`, 'по сверенным с WMS дням: не приехали, с расхождением, недовоз штук, вне графика', RATING_COLUMNS.length)
  const sorted = [...rating].sort((a, b) => b.notArrived - a.notArrived || (b.shortfall || 0) - (a.shortfall || 0) || b.planned - a.planned)
  const t = k => rating.reduce((s, r) => s + (r[k] || 0), 0)
  const total = { supplier: 'Итого', planned: t('planned'), accepted: t('accepted'), discrepancy: t('discrepancy'), waiting: t('waiting'), cancelled: t('cancelled'), notArrived: t('notArrived'), planPieces: t('planPieces'), factPieces: t('factPieces'), extra: t('extra'), extraPieces: t('extraPieces') }
  total.notArrivedPct = total.planned ? total.notArrived / total.planned : null
  total.shortfall = total.planPieces ? Math.max(0, total.planPieces - total.factPieces) / total.planPieces : null
  addTable(ws, RATING_COLUMNS, sorted, { freezeCols: 1, total })
}

export async function exportSupplyPeriodXlsx(data, from, to) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'ВС'
  wb.created = new Date()
  const periodLabel = `${fmtD(from)} — ${fmtD(to)}`
  const days = dayStats(data, from, to)

  // 1. статистика — строка на день
  {
    const ws = wb.addWorksheet('статистика')
    titleRows(ws, `Накопительный отчёт по поставкам — ${periodLabel}`, 'факт — по сверке с WMS (принятые + вне графика); где сверки нет — из загруженного накопительного отчёта', 14)
    const h1 = ws.addRow(['ДН', 'Дата', ...METRICS.flatMap(([, l]) => [l, '', ''])])
    const h2 = ws.addRow(['', '', ...METRICS.flatMap(() => ['план', 'факт', '%'])])
    for (let i = 0; i < METRICS.length; i++) ws.mergeCells(h1.number, 3 + i * 3, h1.number, 5 + i * 3)
    ws.mergeCells(h1.number, 1, h2.number, 1)
    ws.mergeCells(h1.number, 2, h2.number, 2)
    for (const r of [h1, h2]) r.eachCell({ includeEmpty: true }, c => { c.style = { font: { bold: true }, fill: SUBHDR_FILL, border: BORDER, alignment: { horizontal: 'center', vertical: 'middle' } } })

    const sumPlan = { count: 0, pieces: 0, weightKg: 0, sku: 0 }, sumFact = { count: 0, pieces: 0, weightKg: 0, sku: 0 }
    let factDays = 0
    const line = (vals, bold) => {
      const r = ws.addRow(vals)
      r.eachCell({ includeEmpty: true }, (c, i) => {
        c.border = BORDER
        if (bold) c.font = { bold: true }
        if (i > 2) { const k = (i - 3) % 3; c.numFmt = k === 2 ? PCT : METRICS[Math.floor((i - 3) / 3)][2]; c.alignment = { horizontal: 'center' } }
        else c.alignment = { horizontal: 'center' }
      })
    }
    for (const d of days) {
      const v = [weekday(d.date), excelDate(`${d.date}T12:00:00Z`)]
      for (const [k] of METRICS) {
        const p = d.plan[k] || null, f = d.fact ? d.fact[k] : null
        v.push(p, f, f != null && p ? pct(f, p) : null)
        sumPlan[k] += d.plan[k]
        if (d.fact) sumFact[k] += d.fact[k]
      }
      if (d.fact) factDays++
      line(v)
      ws.getCell(ws.lastRow.number, 2).numFmt = 'dd.mm.yyyy'
    }
    const tv = ['Итого', '']
    for (const [k] of METRICS) tv.push(sumPlan[k], factDays ? sumFact[k] : null, factDays && sumPlan[k] ? pct(sumFact[k], sumPlan[k]) : null)
    line(tv, true)
    ws.getColumn(1).width = 7
    ws.getColumn(2).width = 12
    for (let c = 3; c <= 14; c++) ws.getColumn(c).width = 12
    ws.views = [{ state: 'frozen', xSplit: 2, ySplit: h2.number }]
  }

  // 2. рейтинг поставщиков (по сверенным дням)
  if (data.facts?.length) addRatingSheet(wb, supplierRating(data), periodLabel)

  // 3. лист на каждый день — список заказов
  const plansBy = new Map(), factsBy = new Map()
  for (const p of data.plans) { if (!plansBy.has(p.date)) plansBy.set(p.date, []); plansBy.get(p.date).push(p) }
  for (const f of data.facts || []) { if (!factsBy.has(f.date)) factsBy.set(f.date, []); factsBy.get(f.date).push(f) }
  for (const d of days) {
    const plan = plansBy.get(d.date) || []
    const facts = factsBy.get(d.date) || []
    if (!plan.length && !facts.length) continue
    const hasFact = facts.length > 0
    const fBy = new Map(facts.filter(f => !f.extra).map(f => [f.orderNumber, f]))
    const rows = plan.map(p => {
      const f = fBy.get(p.orderNumber)
      return {
        supplier: p.supplier, orderNumber: p.orderNumber, docType: p.docType, supplyType: p.supplyType, storageType: p.storageType,
        sku: p.sku, pieces: p.pieces, weight: p.weightKg,
        factSku: f?.factSku ?? null, factPieces: f?.factPieces ?? null, factWeight: f?.factWeightKg ?? null,
        diffPieces: f?.factPieces != null && p.pieces ? pct(f.factPieces, p.pieces) : null,
        status: hasFact ? STATUS_LABEL[f?.status || 'missing'] : '', gate: f?.gate || '', completedAt: excelDate(f?.completedAt),
      }
    })
    for (const f of facts.filter(x => x.extra)) {
      rows.push({
        supplier: f.supplier, orderNumber: f.orderNumber, docType: '', supplyType: f.supplyType === 'CROSSDOCK' ? 'Кросс-докинг' : 'Хранение', storageType: WMS_STORAGE[f.storageType] || f.storageType,
        factSku: f.factSku, factPieces: f.factPieces, factWeight: f.factWeightKg, status: STATUS_LABEL.extra, gate: f.gate, completedAt: excelDate(f.completedAt),
      })
    }
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
    const ws = wb.addWorksheet(fmtD(d.date))
    titleRows(ws, `${weekday(d.date)} ${fmtD(d.date)} — заказы`, hasFact ? 'план и факт по сверке с WMS' : 'план (день не сверяли с WMS)', cols.length)
    const sum = k => rows.reduce((s, r) => s + (r[k] || 0), 0)
    addTable(ws, cols, rows, { freezeCols: 2, total: { supplier: 'Итого', sku: sum('sku'), pieces: sum('pieces'), weight: sum('weight'), ...(hasFact ? { factSku: sum('factSku'), factPieces: sum('factPieces'), factWeight: sum('factWeight') } : {}) } })
  }

  const buf = await wb.xlsx.writeBuffer()
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `накопительный_отчёт_поставки_${from}_${to}.xlsx`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function exportSupplierRatingXlsx(rating, from, to) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'ВС'
  addRatingSheet(wb, rating, `${fmtD(from)} — ${fmtD(to)}`)
  const buf = await wb.xlsx.writeBuffer()
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `рейтинг_поставщиков_${from}_${to}.xlsx`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
