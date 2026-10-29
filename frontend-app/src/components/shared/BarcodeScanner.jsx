import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Flashlight, FlashlightOff, Loader2, ScanBarcode, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { cameraSupported, getDetector } from '@/lib/barcodeScan'

const SCAN_EVERY_MS = 140
const REPEAT_PAUSE_MS = 1500 // непрерывный режим: тот же код не чаще раза в 1,5 с

/**
 * Сканер штрихкодов камерой телефона, на весь экран. Распознаётся полоса
 * в центре кадра (рамка) — так быстрее и точнее для длинных Code 128.
 * onResult(text) — после скана; continuous — не закрываться, сканировать
 * дальше (например, товары подряд); onClose — закрыть.
 */
export function BarcodeScanner({ onResult, onClose, continuous = false, title = 'Наведите камеру на штрихкод' }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const trackRef = useRef(null)
  const lastRef = useRef({ text: '', at: 0 })
  const [state, setState] = useState('starting') // starting | scanning | error
  const [error, setError] = useState('')
  const [torch, setTorch] = useState(null) // null — фонарика нет
  const [last, setLast] = useState('')
  const onResultRef = useRef(onResult)
  onResultRef.current = onResult

  useEffect(() => {
    let stopped = false
    let timer = null
    let stream = null

    const start = async () => {
      if (!cameraSupported()) throw new Error('Камера недоступна: нужен браузер с поддержкой камеры и защищённое соединение (https)')
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } })
      if (stopped) return
      const track = stream.getVideoTracks()[0]
      trackRef.current = track
      try { if (track.getCapabilities?.().torch) setTorch(false) } catch { /* нет фонарика */ }
      // автофокус непрерывно, где камера умеет
      try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }) } catch { /* не поддерживается */ }
      const video = videoRef.current
      video.srcObject = stream
      await video.play()
      const detector = await getDetector()
      if (stopped) return
      setState('scanning')

      const tick = async () => {
        if (stopped) return
        const v = videoRef.current, c = canvasRef.current
        if (v && c && v.videoWidth) {
          // полоса по центру кадра: 90% ширины × 40% высоты, не шире 1280 px
          const sw = v.videoWidth * 0.9, sh = v.videoHeight * 0.4
          const k = Math.min(1, 1280 / sw)
          c.width = Math.round(sw * k)
          c.height = Math.round(sh * k)
          c.getContext('2d', { willReadFrequently: true }).drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, 0, 0, c.width, c.height)
          try {
            const codes = await detector.detect(c)
            const text = codes[0]
            const now = Date.now()
            if (text && !(text === lastRef.current.text && now - lastRef.current.at < REPEAT_PAUSE_MS)) {
              lastRef.current = { text, at: now }
              navigator.vibrate?.(60)
              setLast(text)
              onResultRef.current?.(text)
              if (!continuous) { stopped = true; return }
            }
          } catch { /* кадр не распознан — следующий */ }
        }
        timer = setTimeout(tick, SCAN_EVERY_MS)
      }
      tick()
    }

    start().catch(err => {
      if (stopped) return
      setState('error')
      setError(err?.name === 'NotAllowedError'
        ? 'Нет доступа к камере — разрешите его в настройках браузера для этого сайта'
        : err?.name === 'NotFoundError' ? 'Камера не найдена' : (err?.message || 'Не удалось включить камеру'))
    })

    return () => {
      stopped = true
      clearTimeout(timer)
      stream?.getTracks().forEach(t => t.stop())
    }
  }, [continuous])

  const toggleTorch = async () => {
    const on = !torch
    try { await trackRef.current?.applyConstraints({ advanced: [{ torch: on }] }); setTorch(on) } catch { setTorch(null) }
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-black text-white">
      <video ref={videoRef} playsInline muted className="absolute inset-0 size-full object-cover" />
      <canvas ref={canvasRef} className="hidden" />

      {/* затемнение вокруг рамки */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="relative h-[40%] w-[90%] max-w-xl rounded-3xl shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]">
          <div className="absolute inset-0 rounded-3xl border-2 border-white/80" />
          {state === 'scanning' && <div className="absolute inset-x-4 top-1/2 h-0.5 -translate-y-1/2 animate-pulse bg-red-500/80" />}
        </div>
      </div>

      <div className="relative flex items-center justify-between gap-2 p-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-2 text-sm font-medium"><ScanBarcode className="size-5" /> {title}</div>
        <button type="button" onClick={onClose} className="rounded-full bg-white/15 p-2.5 backdrop-blur" aria-label="Закрыть"><X className="size-5" /></button>
      </div>

      <div className="relative mt-auto space-y-3 p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-center">
        {state === 'starting' && <div className="flex items-center justify-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> Включаем камеру…</div>}
        {state === 'error' && <div className="rounded-2xl bg-red-600/90 px-4 py-3 text-sm">{error}</div>}
        {state === 'scanning' && (
          <div className="text-sm text-white/80">
            {continuous && last ? <>Последний: <span className="font-mono font-semibold text-white">{last}</span></> : 'Держите штрихкод в рамке, вдоль неё'}
          </div>
        )}
        <div className="flex items-center justify-center gap-3">
          {torch !== null && (
            <button type="button" onClick={toggleTorch} className={cn('flex items-center gap-2 rounded-full px-4 py-2.5 text-sm backdrop-blur', torch ? 'bg-yellow-400 text-black' : 'bg-white/15')}>
              {torch ? <FlashlightOff className="size-4" /> : <Flashlight className="size-4" />} Фонарик
            </button>
          )}
          {continuous && <button type="button" onClick={onClose} className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black">Готово</button>}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Кнопка «сканировать камерой» рядом с полем ввода; на устройствах без камеры её нет. */
export function ScanButton({ onResult, continuous, title, className, label }) {
  const [open, setOpen] = useState(false)
  if (!cameraSupported()) return null
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title="Сканировать камерой"
        className={cn('inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl border border-input bg-card px-3 text-sm hover:bg-muted', className)}>
        <ScanBarcode className="size-5" />{label}
      </button>
      {open && <BarcodeScanner title={title} continuous={continuous} onClose={() => setOpen(false)}
        onResult={text => { onResult(text); if (!continuous) setOpen(false) }} />}
    </>
  )
}
