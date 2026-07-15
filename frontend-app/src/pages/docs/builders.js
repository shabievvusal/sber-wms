// Перенесено «точь-в-точь» из оригинала (frontend/app/src/pages/docs/DocsPage.jsx,
// строки 1-327) — юридический/кадровый текст шаблонов служебных записок и
// объяснительных, ссылки на разделы должностной инструкции. Это контент, а не
// вёрстка — менять нечего, кроме собственно UI-обвязки в DocsPage.jsx.

export const STORAGE_KEY_SUPERVISORS = 'memos_supervisors' // тот же ключ, что и в ConsolidationPage.jsx — список общий

export const DI = {
  receiving: {
    label: 'Кладовщик (участок приема)',
    duty: 'раздел 3 ДИ, п. 3.1.1 (приемка ТМЦ, работа в ТСД/учетных системах, контроль корректности операций), раздел 3.1.3 (отчетность)',
    resp: 'раздел 5 ДИ (ответственность за ненадлежащее исполнение обязанностей, последствия ошибок, материальный ущерб)',
  },
  placement: {
    label: 'Кладовщик (участок размещения)',
    duty: 'раздел 3 ДИ, п. 3.1.1 (размещение ТМЦ, работа в ТСД/учетных системах, корректное оформление операций), раздел 3.1.3 (отчетность)',
    resp: 'раздел 5 ДИ (персональная ответственность за последствия решений и ошибок в операциях)',
  },
  forklift: {
    label: 'Водитель погрузчика (участок размещения)',
    duty: 'раздел 3 ДИ, п. 3.1.1 и 3.1.2 (выполнение работ ПРТ и погрузо-разгрузочных операций по установленным правилам)',
    resp: 'раздел 5 ДИ (ответственность за нарушения требований, причиненный ущерб и последствия решений)',
  },
}

const TC_RECIPIENT = 'Геращенко И.С.'
const TC_ORG = 'СТПС ООО «СберЛогистика»'

const TC_COMPANY_NAMES = {
  'два колеса': 'ООО "Два Колеса"',
  '2 колеса': 'ООО "Два Колеса"',
  'ооо "два колеса"': 'ООО "Два Колеса"',
  'мувинг': 'ООО "Мувинговая компания"',
  'мувинговая': 'ООО "Мувинговая компания"',
  'мувинговая компания': 'ООО "Мувинговая компания"',
  'ооо "мувинговая компания"': 'ООО "Мувинговая компания"',
  'градус': 'ООО "Градус"',
  'ооо "градус"': 'ООО "Градус"',
  'эни ком сервис': 'ООО "Эни Ком Сервис"',
  'эни сервис ком': 'ООО "Эни Ком Сервис"',
  'эск': 'ООО "Эни Ком Сервис"',
  'ооо "эни ком сервис"': 'ООО "Эни Ком Сервис"',
}

export const DOC_KIND_LABEL = {
  bidu: 'Служебная (BIDU)',
  surplus: 'Служебная (Излишки)',
  tc: 'Служебная ТС',
  exp: 'Объяснительная',
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function fmtDate(v) {
  if (!v) return '___ . ___ . ______'
  const [y, m, d] = v.split('-')
  return `${d}.${m}.${y}`
}

function nonEmpty(v, fallback) {
  return (v || '').trim() || fallback
}

function ruPlural(n, one, few, many) {
  const num = Math.abs(Number(n))
  if (!Number.isFinite(num)) return many
  const mod10 = num % 10, mod100 = num % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

function qtyWithWord(raw, one, few, many) {
  const text = String(raw || '').trim().replace(',', '.')
  if (!text) return '________________'
  const n = Number(text)
  if (!Number.isFinite(n)) return text
  return `${text} ${ruPlural(n, one, few, many)}`
}

export function formatCompanyForSz(raw) {
  if (!raw || !String(raw).trim()) return '________________'
  const key = String(raw).trim().toLowerCase()
  return TC_COMPANY_NAMES[key] || (key.startsWith('ооо "') ? raw.trim() : `ООО "${raw.trim()}"`)
}

export function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function getSupervisors() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY_SUPERVISORS) || '[]') } catch { return [] }
}

export function saveSupervisors(arr) {
  localStorage.setItem(STORAGE_KEY_SUPERVISORS, JSON.stringify(arr))
}

// ─── Document builders ──────────────────────────────────────────────────────

function buildBidu(f) {
  const r = DI[f.role]
  return [
    'СЛУЖЕБНАЯ ЗАПИСКА',
    'О выявленных нарушениях в процессе работы',
    '',
    `Настоящим сообщаю, что ${fmtDate(f.date)} у сотрудника ${nonEmpty(f.fioGen, nonEmpty(f.fio, '________________'))} выявлено нарушение:`,
    'некорректное применение кода BIDU.',
    '',
    `Товар: ${nonEmpty(f.product, '________________')}`,
    `Артикул: ${nonEmpty(f.article, '________________')}`,
    `Количество: ${qtyWithWord(f.quantity, 'единица', 'единицы', 'единиц')}`,
    `ЕО: ${nonEmpty(f.eo, '________________')}`,
    '',
    'Обоснование (ДИ):',
    `1. Нарушены обязанности: ${r.duty}.`,
    `2. Подлежит оценке ответственность: ${r.resp}.`,
    '',
    'Прошу:',
    '1. Запросить письменную объяснительную у сотрудника.',
    '2. Провести служебную проверку обстоятельств.',
    '3. Принять решение о мерах воздействия в соответствии с локальными актами и ТК РФ.',
    '',
    `Составил: ${nonEmpty(f.author, '________________')}`,
    `Должность: ${nonEmpty(f.authorRole, '________________')}`,
    'Подпись: __________________',
  ].join('\n')
}

function buildSurplus(f) {
  const r = DI[f.role]
  return [
    'СЛУЖЕБНАЯ ЗАПИСКА',
    'О выявленных нарушениях в процессе работы',
    '',
    `Настоящим сообщаю, что ${fmtDate(f.date)} у сотрудника ${nonEmpty(f.fioGen, nonEmpty(f.fio, '________________'))} выявлено нарушение формирования отправления:`,
    'обнаружен излишек ТМЦ.',
    '',
    `Товар: ${nonEmpty(f.product, '________________')}`,
    `Артикул: ${nonEmpty(f.article, '________________')}`,
    `Излишек в количестве: ${qtyWithWord(f.quantity, 'единица', 'единицы', 'единиц')}`,
    `ЕО: ${nonEmpty(f.eo, '________________')}`,
    '',
    'Обоснование (ДИ):',
    `1. Нарушены обязанности: ${r.duty}.`,
    `2. Подлежит оценке ответственность: ${r.resp}, при наличии ущерба — с учетом ст. 243 ТК РФ.`,
    '',
    'Прошу:',
    '1. Запросить письменную объяснительную у сотрудника.',
    '2. Провести служебную проверку причин возникновения излишка.',
    '3. Принять корректирующие меры для исключения повторения.',
    '',
    `Составил: ${nonEmpty(f.author, '________________')}`,
    `Должность: ${nonEmpty(f.authorRole, '________________')}`,
    'Подпись: __________________',
  ].join('\n')
}

function buildExp(f) {
  const r = DI[f.role]
  const measures = (f.expMeasures || '').split('\n').map(s => s.trim()).filter(Boolean)
  const measuresBlock = measures.length
    ? measures.map((m, i) => `${i + 1}. ${m}`).join('\n')
    : '1. Усилить самоконтроль при выполнении операций.\n2. Проводить двойную сверку по ТСД.'
  return [
    'ОБЪЯСНИТЕЛЬНАЯ ЗАПИСКА',
    '',
    `Я, ${nonEmpty(f.fio, '________________')}, должность «${r.label}», по факту нарушения от ${fmtDate(f.date)} сообщаю следующее:`,
    '',
    `В ходе операции «${nonEmpty(f.expOp, '________________')}» по товару «${nonEmpty(f.product, '________________')}» (артикул ${nonEmpty(f.article, '________________')}, ЕО ${nonEmpty(f.eo, '________________')}) мной была допущена ошибка:`,
    `${nonEmpty(f.expIssue, '________________')}`,
    '',
    'Причины:',
    `1. ${nonEmpty(f.expReason1, '________________')}`,
    `2. ${nonEmpty(f.expReason2, '________________')}`,
    '',
    'Признаю, что нарушение относится к требованиям должностной инструкции:',
    `1. ${r.duty}.`,
    `2. ${r.resp}.`,
    '',
    'Для недопущения повторения обязуюсь:',
    measuresBlock,
    '',
    `Дата: ${fmtDate(f.date)}`,
    `Подпись: __________________ / ${nonEmpty(f.fio, '________________')}`,
  ].join('\n')
}

function buildTcText(f) {
  const dateInc = f.tcDateIncident || f.date
  const dateMemo = f.tcDateMemo || f.date
  const company = formatCompanyForSz(f.tcCompany || '')
  const violator = nonEmpty(f.tcViolator, '________________')
  const product = nonEmpty(f.tcProduct, '________________')
  const article = nonEmpty(f.tcArticle, '________________')
  const quantity = nonEmpty(f.tcQuantity, '1')
  const place = nonEmpty(f.tcPlace, '________________')
  const eo = nonEmpty(f.tcEo, '________________')
  const timeStr = nonEmpty(f.tcTime, '')
  const dateTimeStr = timeStr ? `${fmtDate(dateInc)} ${timeStr}` : fmtDate(dateInc)
  const brigadierRaw = f.tcBrigadier ? f.tcBrigadier.trim() : f.tcCompany
  const brigadierCompany = formatCompanyForSz(brigadierRaw || f.tcCompany || '')
  const brigadier = brigadierCompany !== '________________' ? `Бригадир ${brigadierCompany}` : '________________'
  const sender = nonEmpty(f.author, '________________')
  const senderRole = nonEmpty(f.authorRole, 'Начальник смены')
  const utLine = article !== '________________' ? article : '________________'
  return [
    `Начальнику склада\n${TC_ORG}\n${TC_RECIPIENT}\nОт ${senderRole}\n${sender}`,
    '',
    'СЛУЖЕБНАЯ ЗАПИСКА',
    'О выявленных нарушениях в процессе работы',
    '',
    `Настоящим сообщаю, что ${fmtDate(dateInc)}, со стороны сотрудника ${company} были выявлены следующие нарушения:`,
    '',
    `За сотрудником ${violator}`,
    'выявлено нарушение по п.1 приложения №4 от 01.01.2025, а именно нарушение формирования отправления товара:',
    `«${product}»`,
    utLine,
    `в количестве: ${quantity} шт`,
    `Место: ${place}`,
    `EO: ${eo}`,
    `Время: ${dateTimeStr}`,
    '',
    senderRole,
    `Подпись: __________________  ФИО: ${sender}`,
    `Дата: ${fmtDate(dateMemo)}`,
    'Подпись: __________________',
    '',
    'Со служебной запиской ознакомлен',
    'Нарушения подтверждаю',
    brigadier,
    'Подпись: __________________  ФИО: __________________',
  ].join('\n')
}

function buildTcHtml(f) {
  const dateInc = f.tcDateIncident || f.date
  const dateMemo = f.tcDateMemo || f.date
  const company = formatCompanyForSz(f.tcCompany || '')
  const violator = nonEmpty(f.tcViolator, '________________')
  const product = nonEmpty(f.tcProduct, '________________')
  const article = nonEmpty(f.tcArticle, '________________')
  const quantity = nonEmpty(f.tcQuantity, '1')
  const place = nonEmpty(f.tcPlace, '________________')
  const eo = nonEmpty(f.tcEo, '________________')
  const timeStr = nonEmpty(f.tcTime, '')
  const dateTimeStr = timeStr ? `${fmtDate(dateInc)} ${timeStr}` : fmtDate(dateInc)
  const sender = nonEmpty(f.author, '________________')
  const senderRole = nonEmpty(f.authorRole, 'Начальник смены')
  const utDisplay = article !== '________________' ? article : '—'
  const parts = []
  parts.push(`<div class="doc-right"><p>${esc('Начальнику склада')}</p><p>${esc(TC_ORG)}</p><p>${esc(TC_RECIPIENT)}</p><p>${esc('От ' + senderRole)}</p><p>${esc(sender)}</p></div>`)
  parts.push(`<div class="doc-center">СЛУЖЕБНАЯ ЗАПИСКА</div>`)
  parts.push(`<div class="doc-sub">О выявленных нарушениях в процессе работы</div>`)
  parts.push(`<p class="doc-p">Настоящим сообщаю, что <strong>${esc(fmtDate(dateInc))}</strong>, со стороны сотрудника ${esc(company)} были выявлены следующие нарушения:</p>`)
  parts.push(`<p class="doc-p no-indent">За сотрудником <strong>${esc(violator)}</strong></p>`)
  parts.push(`<p class="doc-p no-indent">выявлено нарушение по п.1 приложения №4 от 01.01.2025, а именно нарушение формирования отправления товара:</p>`)
  parts.push(`<p class="doc-p no-indent">«<strong>${esc(product)}</strong>»</p>`)
  parts.push(`<p class="doc-p no-indent"><strong>${esc(utDisplay)}</strong></p>`)
  parts.push(`<p class="doc-p no-indent"><strong>в количестве:</strong> ${esc(quantity)} шт</p>`)
  parts.push(`<p class="doc-p no-indent"><strong>Место:</strong> ${esc(place)}</p>`)
  parts.push(`<p class="doc-p no-indent"><strong>EO:</strong> ${esc(eo)}</p>`)
  parts.push(`<p class="doc-p no-indent"><strong>Время:</strong> ${esc(dateTimeStr)}</p>`)
  parts.push(`<div class="doc-sign-row"><div class="doc-tc-sign"><p><strong>Начальник смены</strong></p><p>Подпись: __________________</p><p>ФИО: ${esc(sender)}</p><p>Дата: ${esc(fmtDate(dateMemo))}</p><p>Подпись: __________________</p></div><div class="doc-tc-ack"><p>Со служебной запиской ознакомлен</p><p>Нарушения подтверждаю</p><p><strong>Бригадир ${esc(company)}</strong></p><p>Подпись: __________________ &nbsp; ФИО: __________________</p></div></div>`)
  return parts.join('\n')
}

function renderPaper(text) {
  const lines = String(text || '').split('\n')
  const blocks = []
  let inList = false
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  if (i < lines.length) blocks.push(`<div class="doc-center">${esc(lines[i])}</div>`)
  i++
  if (i < lines.length && lines[i].trim()) blocks.push(`<div class="doc-sub">${esc(lines[i])}</div>`)
  i++
  for (; i < lines.length; i++) {
    const ln = lines[i], t = ln.trim()
    if (!t) continue
    if (inList && !/^\d+\.\s+/.test(t)) { blocks.push('</ol>'); inList = false }
    if (t.startsWith('Дата:')) { blocks.push(`<div class="doc-date">${esc(t)}</div>`); continue }
    if (t === 'Прошу:' || t === 'Причины:' || t.startsWith('Обоснование')) { blocks.push(`<p class="doc-p no-indent"><b>${esc(t)}</b></p>`); continue }
    if (/^\d+\.\s+/.test(t)) {
      if (!inList) { blocks.push('<ol class="doc-list">'); inList = true }
      blocks.push(`<li>${esc(t.replace(/^\d+\.\s+/, ''))}</li>`)
      continue
    }
    if (t.startsWith('Составил:') || t.startsWith('Должность:') || t.startsWith('Подпись:')) { blocks.push(`<p class="doc-p no-indent doc-sign">${esc(t)}</p>`); continue }
    blocks.push(`<p class="doc-p">${esc(t)}</p>`)
  }
  if (inList) blocks.push('</ol>')
  return blocks.join('\n')
}

export function buildOutput(kind, f) {
  if (kind === 'tc') return { html: buildTcHtml(f), text: buildTcText(f) }
  const text = kind === 'bidu' ? buildBidu(f) : kind === 'surplus' ? buildSurplus(f) : buildExp(f)
  return { html: renderPaper(text), text }
}

export const DOC_PRINT_STYLES = `
  @page { size: A4; margin: 20mm; }
  body { font-family: "Times New Roman", serif; font-size: 12pt; line-height: 1.45; color: #000; margin: 0; }
  .doc-center { text-align: center; font-weight: 700; }
  .doc-sub    { text-align: center; margin-top: 4px; }
  .doc-date   { text-align: right; margin-top: 10px; margin-bottom: 14px; }
  .doc-p      { text-align: justify; text-indent: 1.25cm; margin: 0 0 8px 0; }
  .doc-p.no-indent { text-indent: 0; }
  .doc-list   { margin: 0 0 10px 0; padding-left: 20px; }
  .doc-list li{ margin-bottom: 4px; }
  .doc-sign   { margin-top: 18px; }
  .doc-right  { text-align: right; margin-bottom: 14px; }
  .doc-right p{ margin: 2px 0; }
  .doc-sign-row { display: flex; justify-content: space-between; margin-top: 18px; gap: 24px; }
  .doc-tc-sign  { flex: 1; }
  .doc-tc-sign p{ margin: 4px 0; }
  .doc-tc-ack   { flex: 1; text-align: right; max-width: 50%; }
  .doc-tc-ack p { margin: 2px 0; }
`
