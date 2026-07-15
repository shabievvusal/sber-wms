import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'

// Полноэкранный просмотр фото отгрузки/приёмки. Те же фото-эндпоинты, что и в
// оригинале (/rk-photos/...), поэтому подключать без изменений на бэкенде.
export default function Lightbox({ photos, idx, onClose, onNav }) {
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    setLoaded(false)
    const img = new Image()
    img.src = photos[idx]
    img.onload = () => setLoaded(true)
    return () => { img.onload = null }
  }, [photos, idx])

  useEffect(() => {
    const handler = e => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') onNav(-1)
      if (e.key === 'ArrowRight') onNav(1)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, onNav])

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <button
        className="absolute top-4 right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
        onClick={onClose}
      >
        <X className="size-5" />
      </button>

      {photos.length > 1 && (
        <button
          className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 disabled:opacity-30"
          onClick={() => onNav(-1)}
        >
          <ChevronLeft className="size-6" />
        </button>
      )}

      <img
        src={photos[idx]}
        alt=""
        className={cnLoading(loaded)}
        style={{ maxWidth: '90vw', maxHeight: '85vh', objectFit: 'contain' }}
      />

      {photos.length > 1 && (
        <button
          className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 disabled:opacity-30"
          onClick={() => onNav(1)}
        >
          <ChevronRight className="size-6" />
        </button>
      )}

      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-sm text-white">
        {idx + 1} / {photos.length}
      </div>
    </div>,
    document.body
  )
}

function cnLoading(loaded) {
  return `rounded-md transition-opacity duration-150 ${loaded ? 'opacity-100' : 'opacity-60'}`
}
