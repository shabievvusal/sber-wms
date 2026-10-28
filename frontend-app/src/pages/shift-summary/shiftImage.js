// Картинка (PNG) «Итог смены» для чата руководства: по каждой операции —
// итоги (операций, штук, кг, сотрудников, в час на человека) и топ
// сотрудников. Canvas, светлая тема, двойное разрешение — как картинки
// графика поставок (supply-plan/supplyPlanImage.js).

import { shortFio } from '@/pages/picking/format'

const C = { bg: '#FFFFFF', ink: '#0F172A', muted: '#64748B', line: '#E2E8F0', head: '#1E3A5F', card: '#F8FAFC' }
const FONT = '"Segoe UI", Roboto, Arial, sans-serif'
const num = v => Math.round(v || 0).toLocaleString('ru-RU')
const dec = v => (v == null ? '—' : v.toLocaleString('ru-RU', { maximumFractionDigits: 1 }))

// blocks: [{ label, unit, summary }] — summary из shiftSummary()
function render({ title, subtitle, blocks }) {
  const pad = 32, gap = 16, cols = 2
  const cardW = 470
  const width = pad * 2 + cardW * cols + gap * (cols - 1)
  const topN = Math.max(0, ...blocks.map(b => b.summary.top.length))
  const cardH = 52 + 62 + 30 + topN * 28 + 14
  const rowsN = Math.ceil(blocks.length / cols) || 1
  const height = pad + 70 + rowsN * cardH + (rowsN - 1) * gap + 40 + pad

  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const ctx = canvas.getContext('2d')
  ctx.scale(scale, scale)
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, width, height)
  ctx.textBaseline = 'middle'
  const text = (s, x, y, { size = 14, weight = 400, color = C.ink, align = 'left', maxW } = {}) => {
    ctx.font = `${weight} ${size}px ${FONT}`
    ctx.fillStyle = color
    ctx.textAlign = align
    let str = String(s)
    if (maxW) while (str.length > 1 && ctx.measureText(str).width > maxW) str = str.slice(0, -2) + '…'
    ctx.fillText(str, x, y)
  }
  const rect = (x, y, w, h, fill, r = 0) => {
    ctx.fillStyle = fill
    ctx.beginPath()
    ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h)
    ctx.fill()
  }

  text(title, pad, pad + 16, { size: 24, weight: 700 })
  text(subtitle, pad, pad + 46, { size: 14, color: C.muted })

  blocks.forEach((b, i) => {
    const x = pad + (i % cols) * (cardW + gap)
    let y = pad + 70 + Math.floor(i / cols) * (cardH + gap)
    const s = b.summary
    rect(x, y, cardW, cardH, C.card, 14)
    rect(x, y, cardW, 40, C.head, 14)
    rect(x, y + 26, cardW, 14, C.head)
    text(b.label, x + 16, y + 20, { size: 16, weight: 700, color: '#fff' })
    text(`${s.people} чел.`, x + cardW - 16, y + 20, { size: 13, color: '#CBD5E1', align: 'right' })
    y += 52

    // четыре итога — по центру своих колонок
    const kpi = [[b.unit, num(s.units)], ['штук', num(s.qty)], ['кг', num(s.kg)], [`${b.unitShort} в час на чел.`, dec(s.perHour)]]
    const kw = (cardW - 16) / kpi.length
    kpi.forEach(([label, v], j) => {
      const cx = x + 8 + kw * j + kw / 2
      text(v, cx, y + 16, { size: 22, weight: 700, align: 'center' })
      text(label, cx, y + 42, { size: 11, color: C.muted, align: 'center' })
    })
    y += 62

    // топ сотрудников
    const cUnits = x + cardW - 190, cQty = x + cardW - 115, cRate = x + cardW - 44
    text('Лучшие', x + 16, y + 12, { size: 12, weight: 600, color: C.muted })
    text(b.unitShort, cUnits, y + 12, { size: 11, color: C.muted, align: 'center' })
    text('шт', cQty, y + 12, { size: 11, color: C.muted, align: 'center' })
    text('в час', cRate, y + 12, { size: 11, color: C.muted, align: 'center' })
    y += 30
    s.top.forEach((p, j) => {
      ctx.strokeStyle = C.line
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x + 12, y - 2); ctx.lineTo(x + cardW - 12, y - 2); ctx.stroke()
      text(`${j + 1}. ${shortFio(p.name)}`, x + 16, y + 12, { size: 14, weight: j === 0 ? 700 : 400, maxW: cUnits - x - 50 })
      text(num(p.units), cUnits, y + 12, { size: 14, weight: 600, align: 'center' })
      text(num(p.qty), cQty, y + 12, { size: 13, align: 'center' })
      text(dec(p.perHour), cRate, y + 12, { size: 13, color: C.muted, align: 'center' })
      y += 28
    })
  })

  text(`Сформировано ${new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })} · «в час» — на отработанный час (часы, в которые были операции)`, pad, height - pad - 4, { size: 11, color: C.muted })
  return canvas
}

const toBlob = canvas => new Promise(resolve => canvas.toBlob(resolve, 'image/png'))

export async function downloadShiftPng(opts, fileName) {
  const blob = await toBlob(render(opts))
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function copyShiftPng(opts) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Браузер не умеет копировать картинки — скачайте файл')
  const blob = await toBlob(render(opts))
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}
