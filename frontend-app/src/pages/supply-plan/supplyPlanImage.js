// Картинка (PNG) итогов «Графика поставок» — чтобы переслать в мессенджер.
// Рисуется на Canvas без сторонних библиотек: светлая тема, двойное
// разрешение. Содержимое: дата, 4 итога (план; после сверки — факт и %),
// таблица КДК/хранение × тип хранения, прогноз СЗ КДК, статусы сверки.

import { SUPPLY_GROUPS, pct, storageKeys } from './supplyPlanCalc'

const C = {
  bg: '#FFFFFF', ink: '#0F172A', muted: '#64748B', line: '#E2E8F0',
  head: '#1E3A5F', groupBg: '#F1F5F9', card: '#F8FAFC', red: '#DC2626', green: '#16A34A', brand: '#4F46E5',
}
const FONT = '"Segoe UI", Roboto, Arial, sans-serif'
const METRICS = [['count', 'Поставок'], ['pieces', 'Штук'], ['weightKg', 'Вес, кг'], ['sku', 'SKU']]
const ZERO = { count: 0, pieces: 0, weightKg: 0, sku: 0 }
const num = v => Math.round(v || 0).toLocaleString('ru-RU')
const fmtPct = p => (p == null ? '' : `${p > 0 ? '+' : ''}${(p * 100).toFixed(0)}%`)
const pctColor = p => (p == null || Math.abs(p) < 0.03 ? C.muted : p < 0 ? C.red : C.green)

function renderCanvas({ date, weekday, planSum, factSum, forecast, statusCounts, statusLabels }) {
  const hasFact = !!factSum
  const pad = 32
  const labelW = 230
  // таблица на всю ширину картинки (вровень с карточками итогов)
  const contentW = Math.max(labelW + METRICS.length * (hasFact ? 3 * 96 : 150), 900)
  const cellW = (contentW - labelW) / (METRICS.length * (hasFact ? 3 : 1))
  const tableW = contentW
  const width = contentW + pad * 2

  // строки таблицы
  const rows = []
  for (const g of SUPPLY_GROUPS) {
    const pg = planSum.groups[g.key]
    if (!pg) continue
    const fg = factSum?.groups[g.key]
    rows.push({ label: g.label, plan: pg.totals, fact: fg?.totals || ZERO, strong: true })
    for (const st of storageKeys({ ...pg.byStorage, ...(fg?.byStorage || {}) })) {
      rows.push({ label: st, plan: pg.byStorage[st] || ZERO, fact: fg?.byStorage[st] || ZERO })
    }
  }
  rows.push({ label: 'Итого', plan: planSum.total, fact: factSum?.total || ZERO, strong: true, total: true })

  const rowH = 34
  const headH = hasFact ? 56 : 36
  const cardsH = 104
  const footLines = (forecast?.ok ? 1 : 0) + (statusCounts ? 1 : 0)
  const height = pad + 64 + cardsH + 24 + headH + rows.length * rowH + 20 + footLines * 26 + 28 + pad

  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const ctx = canvas.getContext('2d')
  ctx.scale(scale, scale)
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, width, height)
  ctx.textBaseline = 'middle'
  const text = (s, x, y, { size = 14, weight = 400, color = C.ink, align = 'left' } = {}) => {
    ctx.font = `${weight} ${size}px ${FONT}`
    ctx.fillStyle = color
    ctx.textAlign = align
    ctx.fillText(s, x, y)
  }
  const rect = (x, y, w, h, fill, r = 0) => {
    ctx.fillStyle = fill
    ctx.beginPath()
    ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h)
    ctx.fill()
  }

  // заголовок
  let y = pad
  text(`График поставок · ${weekday}, ${date.split('-').reverse().join('.')}`, pad, y + 16, { size: 24, weight: 700 })
  text(hasFact ? 'План / факт приёмки (сверка с WMS)' : 'План приёмки', pad, y + 46, { size: 14, color: C.muted })
  y += 64

  // карточки итогов
  const gap = 12
  const cardW = (width - pad * 2 - gap * 3) / 4
  METRICS.forEach(([k, label], i) => {
    const x = pad + i * (cardW + gap)
    rect(x, y, cardW, cardsH - 8, C.card, 14)
    text(label, x + 16, y + 20, { size: 13, color: C.muted, weight: 600 })
    text(num(planSum.total[k]), x + 16, y + 52, { size: 28, weight: 700 })
    if (hasFact) {
      const f = factSum.total[k]
      const p = pct(f, planSum.total[k])
      text(`факт ${num(f)}`, x + 16, y + 80, { size: 13, color: C.ink })
      ctx.font = `400 13px ${FONT}`
      text(fmtPct(p), x + 16 + ctx.measureText(`факт ${num(f)}`).width + 8, y + 80, { size: 13, weight: 700, color: pctColor(p) })
    } else {
      text('план', x + 16, y + 80, { size: 13, color: C.muted })
    }
  })
  y += cardsH + 24

  // шапка таблицы
  const x0 = pad
  rect(x0, y, tableW, headH, C.head, 10)
  text('Тип поставки / хранения', x0 + 14, y + (hasFact ? 18 : headH / 2), { size: 13, weight: 600, color: '#fff' })
  METRICS.forEach(([, label], i) => {
    const gx = x0 + labelW + i * cellW * (hasFact ? 3 : 1)
    const gw = cellW * (hasFact ? 3 : 1)
    text(label, gx + gw / 2, y + (hasFact ? 18 : headH / 2), { size: 13, weight: 600, color: '#fff', align: 'center' })
    if (hasFact) ['план', 'факт', '%'].forEach((h, j) => text(h, gx + cellW * j + cellW / 2, y + 41, { size: 11, color: '#CBD5E1', align: 'center' }))
  })
  y += headH

  // строки
  rows.forEach(r => {
    if (r.strong) rect(x0, y, tableW, rowH, r.total ? '#E0E7FF' : C.groupBg)
    ctx.strokeStyle = C.line
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(x0, y + rowH); ctx.lineTo(x0 + tableW, y + rowH); ctx.stroke()
    text(r.label, x0 + (r.strong ? 14 : 30), y + rowH / 2, { size: 14, weight: r.strong ? 700 : 400, color: r.strong ? C.ink : '#334155' })
    METRICS.forEach(([k], i) => {
      const gx = x0 + labelW + i * cellW * (hasFact ? 3 : 1)
      const w = r.strong ? 700 : 400
      if (hasFact) {
        const p = pct(r.fact[k], r.plan[k])
        text(num(r.plan[k]), gx + cellW / 2, y + rowH / 2, { size: 14, weight: w, align: 'center' })
        text(num(r.fact[k]), gx + cellW * 1.5, y + rowH / 2, { size: 14, weight: w, align: 'center' })
        text(fmtPct(p), gx + cellW * 2.5, y + rowH / 2, { size: 13, weight: 600, color: pctColor(p), align: 'center' })
      } else {
        text(num(r.plan[k]), gx + cellW / 2, y + rowH / 2, { size: 14, weight: w, align: 'center' })
      }
    })
    y += rowH
  })
  // вертикальные разделители: между группами (Поставок/Штук/Вес/SKU) —
  // заметные, внутри группы (план/факт/%) — тонкие, чтобы колонки не сливались
  const tableTop = y - rows.length * rowH - headH
  const tableBottom = y
  const vline = (x, top, color, w) => {
    ctx.strokeStyle = color
    ctx.lineWidth = w
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, tableBottom); ctx.stroke()
  }
  METRICS.forEach((_, i) => {
    const gx = x0 + labelW + i * cellW * (hasFact ? 3 : 1)
    vline(gx, tableTop, '#94A3B8', 1.5)
    if (hasFact) [1, 2].forEach(j => vline(gx + cellW * j, tableTop + headH - 22, C.line, 1))
  })
  y += 20

  // прогноз и статусы
  if (forecast?.ok) {
    text(`Прогноз СЗ КДК: ~${num(forecast.value)}`, pad, y + 10, { size: 15, weight: 700, color: C.brand })
    ctx.font = `700 15px ${FONT}`
    const w = ctx.measureText(`Прогноз СЗ КДК: ~${num(forecast.value)}`).width
    text(`  (${num(forecast.x)} ${forecast.metric.label}, погрешность ±${Math.round(forecast.err * 100)}%)`, pad + w, y + 10, { size: 13, color: C.muted })
    y += 26
  }
  if (statusCounts) {
    const parts = Object.entries(statusCounts).filter(([, v]) => v > 0).map(([k, v]) => `${statusLabels[k]}: ${v}`)
    text(parts.join('   ·   '), pad, y + 10, { size: 13, color: C.ink })
    y += 26
  }
  text(`Сформировано ${new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`, pad, y + 14, { size: 11, color: C.muted })
  return canvas
}

const toBlob = canvas => new Promise(resolve => canvas.toBlob(resolve, 'image/png'))

export async function downloadSupplyPlanPng(opts) {
  const blob = await toBlob(renderCanvas(opts))
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `график_поставок_${opts.date}${opts.factSum ? '_факт' : ''}.png`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// В буфер обмена — вставить сразу в чат (Ctrl+V). Нужен https и поддержка
// ClipboardItem в браузере; иначе — ошибка, и остаётся скачать файл.
export async function copySupplyPlanPng(opts) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Браузер не умеет копировать картинки — скачайте файл')
  const blob = await toBlob(renderCanvas(opts))
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}
