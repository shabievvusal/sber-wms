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
 * @param {{ fileSuffix?: string }} [opts] — пометка в имени файла (выбранный фильтр)
 */
export async function exportEmployeesXlsx(rows, { fileSuffix = '' } = {}) {
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
  // символы, недопустимые в имени файла Windows, заменяем пробелом
  const suffix = fileSuffix ? '_' + fileSuffix.replace(/[\\/:*?"<>|]+/g, ' ').trim().replace(/\s+/g, '_') : ''
  a.download = `сотрудники${suffix}_${new Date().toISOString().slice(0, 10)}.xlsx`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ─── Отчёт по учёткам ТСД (для аутсорсинговых компаний) ─────────────────────
// Два листа: «Проблемные учётки» (то, что нужно исправить — отдаётся компаниям)
// и «Все учётки». Пароли в отчёт НЕ попадают: компании они не нужны, а файл
// может уйти дальше.

const STATUS_FILL = { good: 'FFDCFCE7', bad: 'FFFEE2E2', warn: 'FFFEF3C7', muted: 'FFF1F2F5' }
const STATUS_FONT = { good: 'FF15803D', bad: 'FFB91C1C', warn: 'FFB45309', muted: 'FF6B7080' }

function addAccountSheet(wb, title, rows, checks, meta) {
  const ws = wb.addWorksheet(title, { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = [
    { header: 'Компания', key: 'company', width: 28 },
    { header: 'ФИО', key: 'fio', width: 38 },
    { header: 'Номер телефона', key: 'phone', width: 18 },
    { header: 'Статус учётки', key: 'status', width: 22 },
    { header: 'Причина', key: 'reason', width: 52 },
    { header: 'Проверено', key: 'checked', width: 18 },
  ]
  const sorted = [...rows].sort((a, b) =>
    (!a.company - !b.company) ||
    a.company.localeCompare(b.company, 'ru', { numeric: true }) ||
    a.fio.localeCompare(b.fio, 'ru'))
  for (const r of sorted) {
    const check = checks.get(r._id)
    const m = meta.statusMeta(check)
    const statusText = check?.status === 'wms_error' && check.code ? `Ошибка WMS: ${check.code}` : m.label
    const row = ws.addRow({
      company: text(r.company) || NO_COMPANY,
      fio: text(r.fio),
      phone: text(r.phone),
      status: statusText,
      reason: text(meta.statusReason(check)),
      checked: check?.checkedAt ? meta.fmtChecked(check.checkedAt) : '',
    })
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.value = text(cell.value)
      cell.numFmt = '@'
      cell.border = border
      cell.alignment = { vertical: 'middle', wrapText: col === 5 }
      cell.font = { name: 'Calibri', size: 11 }
    })
    const st = row.getCell(4)
    st.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_FILL[m.tone] } }
    st.font = { name: 'Calibri', size: 11, bold: true, color: { argb: STATUS_FONT[m.tone] } }
    if (!text(r.company)) row.getCell(1).font = { name: 'Calibri', size: 11, italic: true, color: { argb: MUTED } }
  }
  const head = ws.getRow(1)
  head.height = 24
  head.eachCell(cell => {
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
    cell.border = border
  })
  ws.autoFilter = { from: 'A1', to: 'F1' }
  return ws
}

/**
 * @param {{ _id: string, fio: string, company: string, phone?: string }[]} rows
 * @param {Map<string, { status: string, code?: string, message?: string, checkedAt?: number }>} checks
 */
export async function exportAccountReportXlsx(rows, checks, { fileSuffix = '' } = {}) {
  const [{ default: ExcelJS }, meta] = await Promise.all([import('exceljs'), import('./accountStatus')])
  const wb = new ExcelJS.Workbook()
  wb.created = new Date()
  const problems = rows.filter(r => meta.isProblem(checks.get(r._id)))
  const ws = addAccountSheet(wb, 'Проблемные учётки', problems, checks, meta)
  if (!problems.length) ws.addRow(['Проблемных учёток нет'])
  addAccountSheet(wb, 'Все учётки', rows, checks, meta)

  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const suffix = fileSuffix ? '_' + fileSuffix.replace(/[\/:*?"<>|]+/g, ' ').trim().replace(/\s+/g, '_') : ''
  a.download = `учётки_ТСД${suffix}_${new Date().toISOString().slice(0, 10)}.xlsx`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
