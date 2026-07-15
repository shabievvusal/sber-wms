// Печать «служебной записки» (СЗ) — перенесено из оригинала практически без
// изменений (buildServiceNoteSection/printServiceNotes в ConsolidationPage.jsx):
// это чистая клиентская функция (открывает окно и вызывает window.print()),
// бэкенд не нужен вообще, кроме URL фото — которые приходят полными URL
// с бэкенда, поэтому фича работает независимо от WMS-поиска или Excel-экспорта.

const SZ_RECIPIENT = 'Геращенко И.С.'
const SZ_ORG = 'СТПС ООО «СберЛогистика»'
const SZ_COMPANY_NAMES = {
  'два колеса': 'ООО "Два Колеса"',
  '2 колеса': 'ООО "Два Колеса"',
  'мувинг': 'ООО "Мувинговая компания"',
  'мувинговая': 'ООО "Мувинговая компания"',
  'мувинговая компания': 'ООО "Мувинговая компания"',
  'градус': 'ООО "Градус"',
  'эни ком сервис': 'ООО "Эни Ком Сервис"',
  'эни сервис ком': 'ООО "Эни Ком Сервис"',
  'эск': 'ООО "Эни Ком Сервис"',
}

function formatDateOnly(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`
}

function formatTimeOnly(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

export function formatCompanyForSz(raw) {
  if (!raw || !String(raw).trim()) return '—'
  const key = String(raw).trim().toLowerCase()
  return SZ_COMPANY_NAMES[key] || (key.startsWith('ооо "') ? raw.trim() : `ООО "${raw.trim()}"`)
}

export function getTaskAreaPhrase(c) {
  if (c.taskArea === 'kdk') return 'выполнял задачу в КДК'
  if (c.taskArea === 'storage') return 'выполняя задачу в хранении'
  const op = (c.operationType || '').toUpperCase()
  if (op === 'PICK_BY_LINE' || op.includes('PALLET')) return 'выполнял задачу в КДК'
  return 'выполняя задачу в хранении'
}

export function getComplaintPhotos(c) {
  return Array.isArray(c.photoFilenames) && c.photoFilenames.length > 0
    ? c.photoFilenames
    : (c.photoFilename ? [c.photoFilename] : [])
}

export function photoUrl(name) {
  if (!name) return ''
  if (name.startsWith('http') || name.startsWith('data:')) return name
  return `/api/consolidation/uploads/${encodeURIComponent(name)}`
}

export function shortFio(fullName) {
  if (!fullName) return '—'
  const parts = String(fullName).trim().split(/\s+/)
  if (parts.length < 2) return parts[0] || '—'
  const [last, first, ...rest] = parts
  const initials = [first, ...rest].filter(Boolean).map(p => p[0].toUpperCase() + '.').join('')
  return `${last} ${initials}`
}

function buildServiceNoteSection(c, supervisorName, companyFullNames) {
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const violator = c.violator?.trim() || '—'
  const violatorShort = shortFio(violator)
  const dateStr = formatDateOnly(c.operationCompletedAt || c.createdAt)
  const timeStr = formatTimeOnly(c.operationCompletedAt || c.createdAt)
  const productName = c.productName?.trim() || '—'
  const productBarcode = c.productBarcode?.trim() || c.barcode?.trim() || '—'
  const eo = c.handlingUnitBarcode?.trim() || c.barcode?.trim() || '—'
  const cell = c.cell?.trim() || '—'
  const quantity = String(c.quantity ?? '1')
  const utDisplay = c.nomenclatureCode?.trim() || ''
  const supervisor = supervisorName?.trim() || ''
  const companyFull = (companyFullNames || {})[c.company?.trim() || ''] || ''
  const p2 = n => String(n).padStart(2, '0')
  const now = new Date()
  const todayStr = `${p2(now.getDate())}.${p2(now.getMonth() + 1)}.${now.getFullYear()}`
  const photoUrls = getComplaintPhotos(c).map(photoUrl)
  const imgs = photoUrls.map(url => `<img src="${url}" alt="Фото" class="sz-photo">`).join('')
  const utBarcodeStr = [utDisplay, productBarcode !== '—' ? `ШК ${esc(productBarcode)}` : ''].filter(Boolean).join(' / ')
  return `
    <div class="sz-page">
      <div class="sz-header">
        <div class="sz-header-top">
          <img src="/icon.png" class="sz-logo" alt="" onerror="this.style.display='none'">
          ${companyFull ? `<div class="sz-company-name">${esc(companyFull)}</div>` : ''}
        </div>
        <div class="sz-header-right">
          <p>Начальнику склада</p>
          <p>${esc(SZ_ORG)}</p>
          <p>${esc(SZ_RECIPIENT)}</p>
          <p>От начальника смены</p>
          <p>${supervisor ? esc(supervisor) : '________________'}</p>
        </div>
      </div>
      <div class="sz-title">Служебная записка</div>
      <div class="sz-title sz-title-sub">о выявленных нарушениях в процессе работы</div>
      <p class="sz-p">Настоящим сообщаю, что ${esc(dateStr)} года за кладовщиком ${esc(violator)} участка комплектации п. Шушары (г. Санкт-Петербург) было выявлено нарушение формирования отправления по п.2 приложения № 4 от 01.01.2025 года, а именно:</p>
      <p class="sz-p sz-p-noident"><b>- ${esc(productName)}${utBarcodeStr ? ` ${esc(utBarcodeStr)}` : ''}</b></p>
      <p class="sz-p sz-p-noident"><b>В количестве: ${esc(quantity)} шт.</b></p>
      <p class="sz-p sz-p-noident"><b>Место: ${esc(cell)}</b></p>
      <p class="sz-p sz-p-noident"><b>ЕО: ${esc(eo)}</b></p>
      <p class="sz-p sz-p-noident"><b>Время: ${esc(dateStr)} ${esc(timeStr)}</b></p>
      <p class="sz-p">Данное нарушение подтверждается камерами видеонаблюдения и результатами приемки на ЦФЗ. Таким образом, зафиксировано ненадлежащее исполнение трудовых обязанностей кладовщиком ${esc(violatorShort)}.</p>
      <p class="sz-p">Подобные ошибки ведут к сбоям в адресации товара, росту недовозов и дополнительной нагрузке на персонал ЦФЗ, что систематически фиксируется в наших сводках.</p>
      <p class="sz-p">Так же данные действия привели к увеличению трудозатрат на обработку указанных позиций: дополнительные проверки, пересчеты и инвентаризации. Появляются риски ухудшения деловой репутации нашей компании, а также недоверию к качеству услуг, оказываемых нашей компанией как исполнителем складских логистических услуг.</p>
      <div class="sz-sign-block">
        <p class="sz-sign-label">Со служебной запиской ознакомлен, нарушения подтверждаю:</p>
        <div class="sz-sign-fields"><span></span><span></span><span></span></div>
        <div class="sz-sign-captions"><span>(Подпись)</span><span>(Расшифровка)</span><span>(Дата)</span></div>
        <p class="sz-sign-label" style="margin-top:18px">Начальник смены:</p>
        <div class="sz-sign-fields"><span></span><span class="sz-prefilled">${supervisor ? esc(supervisor) : ''}</span><span class="sz-prefilled">${todayStr}</span></div>
        <div class="sz-sign-captions"><span>(Подпись)</span><span>(Расшифровка)</span><span>(Дата)</span></div>
      </div>
      ${photoUrls.length > 0 ? `<div class="sz-photos">${imgs}</div>` : ''}
    </div>`
}

export function printServiceNotes(selected, supervisorName, companyFullNames) {
  const sections = selected.map(c => buildServiceNoteSection(c, supervisorName, companyFullNames)).join('')
  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Служебные записки</title>
<style>
@page { size: A4; margin: 20mm; }
body { font-family: "Times New Roman", serif; font-size: 12pt; line-height: 1.45; color: #000; margin: 0; padding: 16px; }
.sz-page { page-break-after: always; padding-bottom: 20px; }
.sz-page:last-child { page-break-after: auto; }
.sz-header { margin-bottom: 20px; }
.sz-header-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.sz-logo { width: 60px; height: auto; display: block; }
.sz-company-name { font-size: 12pt; font-weight: 700; text-align: right; }
.sz-header-right { text-align: right; }
.sz-header-right p { margin: 2px 0; }
.sz-title { text-align: center; font-weight: 700; margin: 8px 0 2px; }
.sz-title-sub { margin-bottom: 14px; }
.sz-p { text-align: justify; text-indent: 1.25cm; margin: 0 0 8px 0; }
.sz-p-noident { text-indent: 0; }
.sz-sign-block { margin-top: 24px; }
.sz-sign-label { margin: 0 0 4px 0; }
.sz-sign-fields { display: flex; gap: 24px; margin-top: 14px; }
.sz-sign-fields span { flex: 1; border-bottom: 1px solid #000; min-width: 100px; padding-bottom: 2px; }
.sz-prefilled { text-align: center; font-size: 11pt; }
.sz-sign-captions { display: flex; gap: 24px; margin-top: 2px; }
.sz-sign-captions span { flex: 1; font-size: 10pt; text-align: center; }
.sz-photos { margin-top: 16px; height: 230mm; display: flex; flex-direction: column; gap: 0; page-break-inside: avoid; }
.sz-photo { width: 100%; flex: 1; min-height: 60mm; object-fit: cover; display: block; border: 1px solid #ccc; box-sizing: border-box; }
</style></head><body>${sections}</body></html>`
  const w = window.open('', '_blank')
  if (!w) return false
  w.document.write(html); w.document.close()
  w.onload = () => { w.focus(); w.print(); w.onafterprint = () => w.close() }
  return true
}
