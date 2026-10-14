// Выгрузка списка сотрудников в Excel (.xlsx): Компания · ФИО · Номер телефона · Пароль.
//
// Именно .xlsx, а не CSV: в CSV нет типов ячеек, и Excel сам решает, что в
// них. Значения, начинающиеся с «=», «+», «-», «@» (телефон «+7 (902)…», ФИО
// из WMS вроде «=Ракеш» или «-»), он принимал за формулы и показывал #ИМЯ?.
// Здесь каждая ячейка явно текстовая — что в списке, то и в файле.

const NO_COMPANY = 'Без компании'

const BRAND = 'FF2563EB'
const BAND = 'FFF1F5FE'      // полоса для чётных компаний
const BORDER = 'FFD9DEE7'
const MUTED = 'FF8A8F9C'

const thin = { style: 'thin', color: { argb: BORDER } }
const border = { top: thin, left: thin, bottom: thin, right: thin }

const text = v => String(v ?? '').replace(/[\r\n]+/g, ' ').trim()

/**
 * @param {{ fio: string, company: string, phone?: string, password?: string }[]} rows
 */
export async function exportEmployeesXlsx(rows) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.created = new Date()
  const ws = wb.addWorksheet('Сотрудники', {
    views: [{ state: 'frozen', ySplit: 1 }], // шапка не уезжает при прокрутке
  })

  ws.columns = [
    { header: 'Компания', key: 'company', width: 30 },
    { header: 'ФИО', key: 'fio', width: 42 },
    { header: 'Номер телефона', key: 'phone', width: 20 },
    { header: 'Пароль', key: 'password', width: 16 },
  ]

  // по компаниям (без компании — в конце), внутри компании по ФИО
  const sorted = [...rows].sort((a, b) =>
    (!a.company - !b.company) ||
    a.company.localeCompare(b.company, 'ru', { numeric: true }) ||
    a.fio.localeCompare(b.fio, 'ru'))

  let band = false
  let prevCompany = null
  for (const r of sorted) {
    const company = text(r.company) || NO_COMPANY
    if (company !== prevCompany) { band = !band; prevCompany = company }
    const row = ws.addRow({ company, fio: text(r.fio), phone: text(r.phone), password: text(r.password) })
    row.height = 18
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      // строка как есть: ExcelJS пишет обычную строку текстом, а формат «@»
      // не даёт Excel переинтерпретировать её при правке ячейки
      cell.value = text(cell.value)
      cell.numFmt = '@'
      cell.border = border
      cell.alignment = { vertical: 'middle', wrapText: false }
      cell.font = { name: 'Calibri', size: 11 }
      if (band) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } }
      if (col === 1) cell.font = company === NO_COMPANY
        ? { name: 'Calibri', size: 11, italic: true, color: { argb: MUTED } }
        : { name: 'Calibri', size: 11, bold: true }
    })
  }

  // шапка
  const head = ws.getRow(1)
  head.height = 24
  head.eachCell(cell => {
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
    cell.border = border
  })
  ws.autoFilter = { from: 'A1', to: 'D1' }

  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `сотрудники_${new Date().toISOString().slice(0, 10)}.xlsx`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
