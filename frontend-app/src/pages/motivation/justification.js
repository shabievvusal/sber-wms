// Обоснование часов по мотивации — Excel на одну компанию (MotivationPage →
// «Обоснование (ZIP)»): нормы и правила расчёта + по каждому человеку
// выработка, % выполнения, часы и причина изменения словами.

import { fmtHours, fmtNum, fmtPct, fmtTime, SHIFT_LABELS, STATUS_META } from './format'

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } }
const BORDER = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
const CUT_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE2E2' } }
const OVER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0ECFF' } }

export function reasonText(r, s, deadlineIso) {
  switch (r.status) {
    case 'no_account':
      return 'Учётка не предоставлена — работа не подтверждена статистикой, часы не засчитаны.'
    case 'late':
      return `Учётка предоставлена в ${fmtTime(r.receivedAt)} при сроке ${fmtTime(deadlineIso)} — часы не засчитаны.`
    case 'no_stats':
      return `Под учёткой ${r.executorName || r.executorId} нет отбора за смену — часы не засчитаны.`
    case 'no_norm':
      return 'Работа без нормы выработки (не комплектовщик) — полная смена.'
    default: break
  }
  const parts = []
  if (r.storageTasks) parts.push(`хранение ${fmtNum(r.storageTasks)} из ${fmtNum(s.storage.tasks)} СЗ`)
  if (r.kdkTasks) parts.push(`КДК ${fmtNum(r.kdkTasks)} из ${fmtNum(s.kdk.tasks)} СЗ`)
  const weightParts = []
  if (r.storageTasks) weightParts.push(`хранение ${fmtNum(r.storageWeightKg)} из ${fmtNum(s.storage.weightKg)} кг`)
  if (r.kdkTasks) weightParts.push(`КДК ${fmtNum(r.kdkWeightKg)} из ${fmtNum(s.kdk.weightKg)} кг`)
  const limitedBy = r.weightPct < r.tasksPct ? 'по весу' : 'по СЗ'
  let text = `Выполнение по СЗ ${fmtPct(r.tasksPct)} (${parts.join(', ')}); по весу ${fmtPct(r.weightPct)} (${weightParts.join(', ')}). Засчитано ${fmtPct(r.pct)} (${limitedBy}).`
  if (r.status === 'under') text += ` Недобор — снято ${fmtHours(-r.deltaHours)} ч.`
  else if (r.status === 'over') text += ` Перевыполнение — добавлено ${fmtHours(r.deltaHours)} ч.`
  else text += ' Изменение меньше шага округления — полная смена.'
  if (r.missingWeightItems > 0) text += ` Для ${r.missingWeightItems} отб. без веса в справочнике вес оценён по среднему весу отбора сотрудника: ${fmtNum(r.estimatedWeightKg)} кг (входит в вес выше).`
  return text
}

/**
 * @param {typeof import('exceljs')} ExcelJS
 * @param {{ company: string, date: string, shift: 'day'|'night', rows: object[], settings: object, deadline: string }} params
 */
export function buildJustificationWorkbook(ExcelJS, { company, date, shift, rows, settings: s, deadline }) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'ВС'
  wb.created = new Date()
  const ws = wb.addWorksheet('Обоснование')

  ws.columns = [
    { width: 5 }, { width: 30 }, { width: 26 }, { width: 10 }, { width: 9 }, { width: 9 },
    { width: 11 }, { width: 11 }, { width: 9 }, { width: 9 }, { width: 9 }, { width: 10 },
    { width: 10 }, { width: 18 }, { width: 70 },
  ]

  const [y, m, d] = date.split('-')
  ws.mergeCells('A1:O1')
  ws.getCell('A1').value = `Обоснование часов по норме выработки — ${company || 'без компании'}`
  ws.getCell('A1').font = { bold: true, size: 13 }
  ws.getCell('A2').value = `Смена: ${SHIFT_LABELS[shift]}, ${d}.${m}.${y}`

  const rules = [
    `Норма «чистое хранение»: ${fmtNum(s.storage.tasks)} СЗ и ${fmtNum(s.storage.weightKg)} кг за смену = ${fmtHours(s.baseHours)} ч; каждые ${fmtNum(s.storage.tasksPerHour)} СЗ недобора — 1 ч.`,
    `Норма «только КДК»: ${fmtNum(s.kdk.tasks)} СЗ и ${fmtNum(s.kdk.weightKg)} кг за смену = ${fmtHours(s.baseHours)} ч; каждые ${fmtNum(s.kdk.tasksPerHour)} СЗ недобора — 1 ч.`,
    'Выполнение считается и по СЗ, и по весу; засчитывается меньшее. При работе и в хранении, и в КДК доли нормы складываются.',
    `Часы меняются шагом ${fmtHours(s.roundStep)} ч; недобор округляется в пользу работника${s.bonusEnabled ? `, перевыполнение добавляет часы (не более ${fmtHours(s.maxHours)} ч)` : ''}.`,
    `Учётки сотрудников — до ${fmtTime(deadline)}. Нет учётки${s.strictDeadline ? ', учётка после срока' : ''} или нет отбора под учёткой — часы не засчитываются.`,
    'Если у товара нет веса в справочнике, вес такого отбора оценивается по среднему весу отбора сотрудника (при отсутствии — по среднему по складу за смену).',
    'Источник данных — выгрузка выполненных заданий WMS за смену.',
  ]
  rules.forEach((text, i) => {
    const cell = ws.getCell(`A${4 + i}`)
    cell.value = text
    ws.mergeCells(`A${4 + i}:O${4 + i}`)
  })

  const headerRowNum = 4 + rules.length + 1
  const headers = ['№', 'Ф.И.О.', 'Учётка', 'Получена', 'СЗ ХР', 'СЗ КДК', 'Вес ХР, кг', 'Вес КДК, кг',
    '% по СЗ', '% по весу', 'Засчитано', 'Часов по норме', 'Изменение', 'Итого часов / статус', 'Причина']
  const headerRow = ws.getRow(headerRowNum)
  headers.forEach((text, i) => {
    const cell = headerRow.getCell(i + 1)
    cell.value = text
    cell.font = HEADER_FONT
    cell.fill = HEADER_FILL
    cell.border = BORDER
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
  })
  headerRow.height = 30

  const computed = r => r.pct > 0
  rows.forEach((r, i) => {
    const row = ws.getRow(headerRowNum + 1 + i)
    const account = r.executorId || r.executorName ? `${r.executorName || ''}${r.executorId ? ` (${r.executorId})` : ''}`.trim() : '—'
    const values = [
      i + 1,
      r.fio,
      account,
      r.receivedAt ? fmtTime(r.receivedAt) : (r.executorId || r.executorName ? 'из статистики' : '—'),
      r.storageTasks || 0,
      r.kdkTasks || 0,
      r.storageWeightKg || 0,
      r.kdkWeightKg || 0,
      computed(r) ? r.tasksPct : null,
      computed(r) ? r.weightPct : null,
      computed(r) ? r.pct : null,
      s.baseHours,
      r.hours - s.baseHours,
      `${fmtHours(r.hours)} — ${STATUS_META[r.status]?.[0] || r.status}`,
      reasonText(r, s, deadline),
    ]
    values.forEach((v, c) => {
      const cell = row.getCell(c + 1)
      cell.value = v
      cell.border = BORDER
      cell.alignment = { vertical: 'middle', wrapText: c === 1 || c === 2 || c === 14 }
      if (c >= 8 && c <= 10 && v != null) cell.numFmt = '0%'
      if (c === 12) cell.numFmt = '+0.0;-0.0;0'
    })
    const fill = r.hours < s.baseHours ? CUT_FILL : r.hours > s.baseHours ? OVER_FILL : null
    if (fill) row.getCell(14).fill = fill
  })

  const totalRow = ws.getRow(headerRowNum + 1 + rows.length)
  const totalHours = rows.reduce((sum, r) => sum + (r.hours || 0), 0)
  totalRow.getCell(2).value = 'Итого'
  totalRow.getCell(12).value = rows.length * s.baseHours
  totalRow.getCell(13).value = totalHours - rows.length * s.baseHours
  totalRow.getCell(13).numFmt = '+0.0;-0.0;0'
  totalRow.getCell(14).value = fmtHours(totalHours)
  for (const c of [2, 12, 13, 14]) {
    totalRow.getCell(c).font = { bold: true }
    totalRow.getCell(c).border = BORDER
  }

  ws.views = [{ state: 'frozen', ySplit: headerRowNum }]
  return wb
}
