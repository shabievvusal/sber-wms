import { createPortal } from 'react-dom'
import { TEMP_LABELS } from './constants'

// Термоэтикетки 100×75 мм с адресами (заданиями штучного отбора на ЦФЗ):
// бригадир сам раскладывает задания в нужном порядке, печатает и выдаёт
// сборщикам — сборщик не выбирает себе лёгкие адреса, пропуская тяжёлые.
// На этикетке крупно то, что нужно найти в списке заданий на ТСД: название
// ЦФЗ, а также число ячеек и вес — понятно и тем, кто плохо читает.
// Печать — тем же приёмом, что этикетки в «Выдаче ТСД»: на время печати
// страница скрывается, видны только этикетки.

const PRINT_CSS = `
.addr-print-portal { display: none; }
@media print {
  body.addr-printing #root { display: none !important; }
  body.addr-printing .addr-print-portal { display: block !important; }
  @page { size: 100mm 75mm; margin: 0; }
}
.addr-label {
  width: 100mm; height: 75mm; box-sizing: border-box; padding: 4mm 5mm;
  display: flex; flex-direction: column; gap: 2.5mm;
  font-family: Arial, "Helvetica Neue", sans-serif; color: #000; background: #fff;
  page-break-after: page; break-after: page; overflow: hidden;
}
.addr-label:last-child { page-break-after: auto; break-after: auto; }
.addr-top { display: flex; justify-content: space-between; align-items: center; font-size: 10pt; font-weight: 700; }
.addr-seq { border: 0.5mm solid #000; border-radius: 1.5mm; padding: 0.3mm 2mm; }
.addr-meta { font-weight: 600; }
.addr-name {
  flex: 1; display: flex; align-items: center; justify-content: center; text-align: center;
  font-weight: 800; line-height: 1.08; word-break: break-word; overflow: hidden;
}
.addr-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm; }
.addr-stat { border: 0.6mm solid #000; border-radius: 2mm; padding: 1mm 2mm; text-align: center; }
.addr-stat-label { font-size: 9pt; font-weight: 700; letter-spacing: 0.3mm; }
.addr-stat-value { font-size: 30pt; font-weight: 800; line-height: 1; }
.addr-foot { display: flex; justify-content: space-between; font-size: 7.5pt; }
`

// длинное название — мельче, чтобы влезло в 2–3 строки
function nameFontSize(name) {
  const n = String(name || '').length
  if (n <= 14) return '30pt'
  if (n <= 22) return '25pt'
  if (n <= 32) return '20pt'
  if (n <= 46) return '16pt'
  return '13pt'
}

function kg(grams) {
  const n = (Number(grams) || 0) / 1000
  if (!n) return '0'
  return n.toLocaleString('ru-RU', { maximumFractionDigits: n < 10 ? 1 : 0 })
}

function day(dateStr) {
  if (!dateStr) return ''
  const [y, m, d] = String(dateStr).slice(0, 10).split('-')
  return `${d}.${m}.${y}`
}

/** Слой с этикетками для печати (вне #root, виден только при печати). */
export function AddressLabelsPrint({ items }) {
  return createPortal(
    <div className="addr-print-portal">
      <style>{PRINT_CSS}</style>
      {items.map((row, i) => {
        const name = row.shipTo?.name || '—'
        const temps = (row.shipmentTemperatureModes || []).map(t => TEMP_LABELS[t] || t).join(', ')
        return (
          <div key={row.id || i} className="addr-label">
            <div className="addr-top">
              <span className="addr-seq">№ {i + 1}</span>
              <span className="addr-meta">{[row.sourceZone?.name, temps].filter(Boolean).join(' · ')}</span>
            </div>
            <div className="addr-name" style={{ fontSize: nameFontSize(name) }}>{name}</div>
            <div className="addr-stats">
              <div className="addr-stat">
                <div className="addr-stat-label">ЯЧЕЕК</div>
                <div className="addr-stat-value">{Number(row.sourceCellsCount) || 0}</div>
              </div>
              <div className="addr-stat">
                <div className="addr-stat-label">ВЕС, КГ</div>
                <div className="addr-stat-value">{kg(row.weightInGrams)}</div>
              </div>
            </div>
            <div className="addr-foot">
              <span>{row.targetHandlingUnitBarcode ? `ЕО ${row.targetHandlingUnitBarcode}` : ''}</span>
              <span>{day(row.logisticDate)}</span>
            </div>
          </div>
        )
      })}
    </div>,
    document.body,
  )
}

/** Напечатать слой этикеток (вызывать после того, как он отрисован). */
export function printAddressLabels() {
  const body = document.body
  const cleanup = () => body.classList.remove('addr-printing')
  body.classList.add('addr-printing')
  window.addEventListener('afterprint', cleanup, { once: true })
  window.print()
  window.setTimeout(cleanup, 1500)
}
