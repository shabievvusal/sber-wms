// Акт учёта времени оказания услуг сотрудниками Исполнителя — воспроизводит
// структуру образца «Мувинг День АКТ (4).xlsx» (адреса ячеек сверены вручную
// распаковкой xlsx), с двумя отличиями по прямому указанию пользователя:
//   — строка «Бригадир» не добавляется вообще;
//   — колонка «№ Жилета» остаётся в шапке, но не заполняется (бланк для
//     заполнения на месте при физической выдаче жилета).
// Плюс мелкое улучшение оформления: шапка таблицы теперь с заливкой/жирным
// шрифтом и рамкой (в образце шапка была голым текстом), и опечатка
// «Смена» в шапке столбца A (по факту это № по порядку) поправлена на «№».

const SERVICE_TYPE_LABEL = 'Услуги по комплектованию и упаковки заказов'

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } }
const BORDER = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
const CENTER = { horizontal: 'center', vertical: 'middle' }

// День: 9:00–21:00; ночь: 21:00–9:00 — те же границы смены, что и в
// backend-dotnet/Services/StatsService.cs:GetShiftKeyFromMoscowDateHour.
// Перерыв и итог часов — как в образце (1.5 ч перерыва, 10.5 ч отработано).
const SHIFT_TIMES = {
  day: { start: 9 / 24, end: 21 / 24, breakHours: 1.5, totalHours: 10.5, label: 'ДЕНЬ' },
  night: { start: 21 / 24, end: 9 / 24, breakHours: 1.5, totalHours: 10.5, label: 'НОЧЬ' },
}

/**
 * Строит один workbook Акта для одной компании.
 * @param {object} params
 * @param {string} params.customerName Заказчик
 * @param {string} params.contractorFullName Исполнитель (официальное название)
 * @param {string} params.warehouseAddress
 * @param {string} params.warehouseType
 * @param {string} params.warehouseCategory
 * @param {Date} params.date Дата смены
 * @param {'day'|'night'} params.shift
 * @param {{name: string}[]} params.employees
 * @param {typeof import('exceljs')} ExcelJS — передаётся вызывающим кодом
 *   (динамический импорт делается один раз на все акты, не на каждый).
 */
export function buildActWorkbook(ExcelJS, params) {
  const { customerName, contractorFullName, warehouseAddress, warehouseType, warehouseCategory, date, shift, employees } = params
  const times = SHIFT_TIMES[shift] || SHIFT_TIMES.day

  const wb = new ExcelJS.Workbook()
  wb.creator = 'ВС'
  wb.created = new Date()
  const ws = wb.addWorksheet('Акт')

  ws.columns = [
    { width: 5 }, { width: 30 }, { width: 26 }, { width: 11 },
    { width: 9 }, { width: 9 }, { width: 9 }, { width: 11 }, { width: 14 },
  ]

  const setLabelRow = (rowNum, label, value) => {
    const row = ws.getRow(rowNum)
    row.getCell(1).value = label
    row.getCell(1).font = { bold: true }
    row.getCell(3).value = value
  }

  ws.mergeCells('A2:I2')
  const titleCell = ws.getCell('A2')
  titleCell.value = 'Акт учета времени оказания услуг сотрудниками Исполнителя'
  titleCell.font = { bold: true, size: 13 }
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(2).height = 22

  setLabelRow(4, 'Заказчик:', customerName)
  setLabelRow(5, 'Исполнитель:', contractorFullName)
  setLabelRow(7, 'Адрес склада:', warehouseAddress)
  setLabelRow(8, 'Тип склада:', warehouseType)
  setLabelRow(9, 'Категория склада:', warehouseCategory)

  ws.getCell('A10').value = 'Дата'
  ws.getCell('A10').font = { bold: true }
  const dateCell = ws.getCell('C10')
  dateCell.value = date
  dateCell.numFmt = 'dd.mm.yyyy'

  const shiftRowNum = 13
  const shiftRow = ws.getRow(shiftRowNum)
  shiftRow.getCell(1).value = 'Смена'
  shiftRow.getCell(1).font = { bold: true }
  shiftRow.getCell(3).value = times.label
  shiftRow.getCell(5).value = 'Количество персонала'
  shiftRow.getCell(5).font = { bold: true }
  shiftRow.getCell(9).value = employees.length

  const headerRowNum = 14
  const headers = ['№', 'Ф.И.О.', 'Вид услуг', '№ Жилета', 'Начало', 'Окончание', 'Перерыв', 'Кол-во часов', 'Подпись']
  const headerRow = ws.getRow(headerRowNum)
  headers.forEach((text, i) => {
    const cell = headerRow.getCell(i + 1)
    cell.value = text
    cell.font = HEADER_FONT
    cell.fill = HEADER_FILL
    cell.border = BORDER
    cell.alignment = { ...CENTER, wrapText: true }
  })
  headerRow.height = 28

  employees.forEach((emp, i) => {
    const r = ws.getRow(headerRowNum + 1 + i)
    r.getCell(1).value = i + 1
    r.getCell(2).value = emp.name
    r.getCell(3).value = SERVICE_TYPE_LABEL
    r.getCell(4).value = null // № Жилета — намеренно не заполняется
    r.getCell(5).value = times.start
    r.getCell(5).numFmt = 'h:mm'
    r.getCell(6).value = times.end
    r.getCell(6).numFmt = 'h:mm'
    r.getCell(7).value = times.breakHours
    r.getCell(8).value = times.totalHours
    r.getCell(9).value = null // Подпись — от руки
    for (let col = 1; col <= 9; col++) {
      const cell = r.getCell(col)
      cell.border = BORDER
      cell.alignment = col === 2 || col === 3 ? { vertical: 'middle', wrapText: true } : { ...CENTER }
    }
  })

  let r = headerRowNum + 1 + employees.length + 1
  ws.getCell(`C${r}`).value = '______________________'
  ws.getCell(`F${r}`).value = '_____________________________'
  r += 1
  ws.getCell(`B${r}`).value = 'От Исполнителя'
  ws.getCell(`C${r}`).value = '(подпись)'
  ws.getCell(`F${r}`).value = '(расшифровка)'
  r += 3
  ws.getCell(`B${r}`).value = 'От Заказчика: '
  ws.getCell(`C${r}`).value = '______________________'
  ws.getCell(`F${r}`).value = '___________________'
  r += 1
  ws.getCell(`C${r}`).value = '(подпись)'
  ws.getCell(`F${r}`).value = '(расшифровка)'

  return wb
}
