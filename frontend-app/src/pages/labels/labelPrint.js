// Печать этикеток 100×75 мм на термопринтере: каждая строка — своя страница
// (@page точно по размеру этикетки, без полей), штрихкод Code 128 и текст.
// Печатается из отдельного окна, чтобы стили сайта не влияли на раскладку.

import { buildCode128Bars, canCode128 } from '@/pages/picking/Code128Barcode'

export const LABEL_SIZES = {
  '100x75': { w: 100, h: 75, label: '100 × 75 мм' },
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// Размер текста под длину строки — чтобы короткие коды читались издалека
export function textSizeMm(text) {
  const n = String(text).length
  return n <= 8 ? 14 : n <= 12 ? 10 : n <= 16 ? 8 : n <= 24 ? 6 : 4.5
}

// Полосы штрихкода как SVG (без подписи — текст печатается отдельно, крупно)
function barcodeSvg(value) {
  const { bars, width } = buildCode128Bars(value)
  const rects = bars.map(b => `<rect x="${b.x}" y="0" width="${b.width}" height="1" />`).join('')
  return `<svg viewBox="0 0 ${width} 1" preserveAspectRatio="none" shape-rendering="crispEdges">${rects}</svg>`
}

function labelHtml(text, { showText }) {
  const coded = canCode128(text)
  const size = textSizeMm(text)
  return `<div class="label">
  ${coded ? `<div class="bc">${barcodeSvg(text)}</div>` : ''}
  ${showText || !coded ? `<div class="txt" style="font-size:${coded ? size : Math.max(size, 8)}mm">${esc(text)}</div>` : ''}
</div>`
}

export function printLabels(lines, { size = '100x75', showText = true } = {}) {
  const { w, h } = LABEL_SIZES[size]
  const win = window.open('', '_blank', 'width=480,height=640')
  if (!win) throw new Error('Браузер заблокировал окно печати — разрешите всплывающие окна для сайта')
  win.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Этикетки (${lines.length})</title>
<style>
  @page { size: ${w}mm ${h}mm; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #fff; }
  body { font-family: Arial, Helvetica, sans-serif; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .label { width: ${w}mm; height: ${h}mm; padding: 4mm 5mm; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3mm; page-break-after: always; break-after: page; overflow: hidden; }
  .label:last-child { page-break-after: auto; break-after: auto; }
  .bc { width: 100%; height: ${Math.round(h * 0.52)}mm; }
  .bc svg { width: 100%; height: 100%; display: block; fill: #000; }
  .txt { font-weight: 700; text-align: center; line-height: 1.05; word-break: break-all; letter-spacing: 0.02em; }
  @media screen { body { background: #e5e7eb; } .label { background: #fff; margin: 4mm auto; box-shadow: 0 1px 4px rgba(0,0,0,.25); } }
</style></head><body>
${lines.map(t => labelHtml(t, { showText })).join('\n')}
<script>window.onload = () => { window.focus(); window.print(); };<\/script>
</body></html>`)
  win.document.close()
}
