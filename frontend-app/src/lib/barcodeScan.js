// Распознавание штрихкодов с камеры. Где есть встроенный BarcodeDetector
// (Chrome на Android) — он: быстрый и бесплатный по батарее. Иначе (iPhone,
// Firefox, ПК) — zxing-wasm; его модуль (~1 МБ) лежит у нас (Vite кладёт
// .wasm в сборку) и грузится только при первом скане, не со стороннего CDN.

import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

// Code 128 — ЕО, ячейки, коды заказов; EAN/UPC — товары
const NATIVE_FORMATS = ['code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39', 'itf', 'qr_code', 'data_matrix']
const ZXING_FORMATS = ['Code128', 'EAN13', 'EAN8', 'UPCA', 'UPCE', 'Code39', 'ITF', 'QRCode', 'DataMatrix']

let detectorPromise = null

async function nativeDetector() {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats()
    const formats = NATIVE_FORMATS.filter(f => supported.includes(f))
    if (!formats.includes('code_128')) return null
    const d = new window.BarcodeDetector({ formats })
    return { kind: 'native', detect: async source => (await d.detect(source)).map(r => r.rawValue).filter(Boolean) }
  } catch {
    return null
  }
}

async function zxingDetector() {
  const { prepareZXingModule, readBarcodes } = await import('zxing-wasm/reader')
  prepareZXingModule({ overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) } })
  return {
    kind: 'zxing',
    // source — canvas с кадром
    detect: async canvas => {
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const res = await readBarcodes(image, { formats: ZXING_FORMATS, tryHarder: true, maxNumberOfSymbols: 1 })
      return res.filter(r => r.isValid && r.text).map(r => r.text)
    },
  }
}

/** Детектор (один на страницу): { kind, detect(canvas) → string[] }. */
export function getDetector() {
  if (!detectorPromise) detectorPromise = nativeDetector().then(d => d || zxingDetector())
  return detectorPromise
}

/** Есть ли вообще камера в браузере (и защищённое соединение для неё). */
export const cameraSupported = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext
