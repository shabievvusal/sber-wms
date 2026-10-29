// Сжимает изображение через Canvas перед загрузкой на сервер — перенесено из
// оригинала (utils/compressImage.js) без изменений, чистая клиентская утилита.
export async function compressImage(file, { maxDim = 1280, quality = 0.82, minSizeKb = 300 } = {}) {
  if (file.size < minSizeKb * 1024) return file

  return new Promise(resolve => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)

      let { width, height } = img
      if (width > maxDim || height > maxDim) {
        if (width >= height) { height = Math.round(height * maxDim / width); width = maxDim }
        else { width = Math.round(width * maxDim / height); height = maxDim }
      }

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d').drawImage(img, 0, 0, width, height)

      canvas.toBlob(
        blob => {
          if (!blob) { resolve(file); return }
          resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }))
        },
        'image/jpeg',
        quality
      )
    }

    img.onerror = () => { URL.revokeObjectURL(url); resolve(file) }
    img.src = url
  })
}

// Сжатие фото в браузере перед отправкой на сервер: фото с телефона (3–8 МБ,
// 12–50 Мп) → JPEG до 1280 px (~150–300 КБ) и миниатюра до 320 px для
// списков. Сервер сохраняет готовые файлы как есть и не тратит на них ни
// процессор, ни память.

const MAX_BYTES = 1.8 * 1024 * 1024 // сервер принимает до 2 МБ на файл

async function decode(file) {
  // createImageBitmap с imageOrientation учитывает поворот из EXIF (фото «на боку»)
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }) } catch { /* ниже — через <img> */ }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

function toJpeg(source, maxSide, quality) {
  const w = source.width, h = source.height
  const k = Math.min(1, maxSide / Math.max(w, h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * k))
  canvas.height = Math.max(1, Math.round(h * k))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff' // прозрачность PNG → белый фон
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Не удалось сжать фото'))), 'image/jpeg', quality))
}

/** Файл изображения → { photo, thumb } (Blob JPEG). */
export async function compressPhoto(file, { maxSide = 1280, thumbSide = 320 } = {}) {
  const source = await decode(file)
  try {
    let quality = 0.78
    let photo = await toJpeg(source, maxSide, quality)
    while (photo.size > MAX_BYTES && quality > 0.4) {
      quality -= 0.15
      photo = await toJpeg(source, maxSide, quality)
    }
    const thumb = await toJpeg(source, thumbSide, 0.7)
    return { photo, thumb }
  } finally {
    source.close?.()
  }
}
