import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Play, Trash2 } from 'lucide-react'

function formatDamage(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString('ru-RU') + ' ₽'
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Перенесено из оригинала (frontend/app/src/pages/violations/ViolationsPage.jsx)
// — плоский видео-лог инцидентов (не путать с «Консолидацией»: там —
// очередь жалоб с WMS-поиском виновника, здесь — просто «название + ущерб +
// видео», без связи с сотрудниками/WMS вообще, см. PLAN.md).
//
// Оригинал вызывает несуществующие `notify.error(...)/notify.success(...)`
// (`useNotify()` в реальном проекте возвращает функцию `notify(msg, type)`,
// а не объект с методами) — каждый такой вызов там бросает TypeError, так что
// пользователь не получает вообще никакой обратной связи. Это баг оригинала,
// не поведение, которое нужно сохранять — здесь используется обычный `toast`.
export default function ViolationsPage() {
  const [violations, setViolations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [previewIdx, setPreviewIdx] = useState(null)
  const [videoErrors, setVideoErrors] = useState(() => new Set())
  const [title, setTitle] = useState('')
  const [damage, setDamage] = useState('')
  const [videoFile, setVideoFile] = useState(null)
  const fileRef = useRef(null)

  useEffect(() => {
    withMinDuration(async () => {
      try {
        setViolations(await api.getViolations())
      } catch (err) {
        setViolations([])
        setError(err.message || 'Не удалось загрузить данные')
      }
    }).finally(() => setLoading(false))
  }, [])

  const resetForm = () => {
    setTitle(''); setDamage(''); setVideoFile(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const handleSubmit = async e => {
    e.preventDefault()
    if (!title.trim()) { toast.error('Введите название нарушения'); return }
    if (!videoFile) { toast.error('Выберите видео-файл'); return }

    setSubmitting(true)
    try {
      const form = new FormData()
      form.append('title', title.trim())
      if (damage) form.append('damage', damage)
      form.append('video', videoFile)
      const created = await api.createViolation(form)
      setViolations(v => [created, ...v])
      toast.success('Нарушение добавлено')
      resetForm()
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id, idx) => {
    if (!window.confirm('Удалить нарушение?')) return
    try {
      await api.deleteViolation(id)
      setViolations(v => v.filter(x => x.id !== id))
      if (previewIdx === idx) setPreviewIdx(null)
      toast.success('Удалено')
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-4 p-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Нарушения</h1>
        <span className="text-sm text-muted-foreground">{violations.length} записей</span>
      </div>

      {error && <div className="text-sm text-destructive">{error}</div>}

      <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap gap-3">
          <Input className="min-w-0 flex-[2] basis-64" placeholder="Нарушение *" value={title} onChange={e => setTitle(e.target.value)} />
          <Input className="w-40 flex-1" type="number" min="0" placeholder="Ущерб (₽)" value={damage} onChange={e => setDamage(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept="video/*"
            onChange={e => setVideoFile(e.target.files?.[0] || null)}
            className="flex-1 text-sm file:mr-3 file:rounded-md file:border file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium"
          />
          <Button type="submit" disabled={submitting}>{submitting ? 'Загрузка...' : 'Добавить'}</Button>
        </div>
      </form>

      {loading && <Spinner label="Загрузка..." />}
      {!loading && violations.length === 0 && (
        <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">Нарушений нет</div>
      )}
      {!loading && violations.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {violations.map((v, idx) => {
            const isPreview = previewIdx === idx
            return (
              <div key={v.id} className={`space-y-2 rounded-lg border bg-card p-3 ${isPreview ? 'border-primary' : ''}`}>
                <button
                  type="button"
                  className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-md bg-muted"
                  onClick={() => setPreviewIdx(prev => (prev === idx ? null : idx))}
                >
                  {isPreview && !videoErrors.has(v.id) ? (
                    <video
                      src={`/violation-videos/${v.videoFile}`}
                      controls autoPlay muted
                      className="size-full object-cover"
                      onError={() => setVideoErrors(prev => new Set(prev).add(v.id))}
                    />
                  ) : isPreview ? (
                    <span className="text-sm text-muted-foreground">Видео недоступно</span>
                  ) : (
                    <Play className="size-10 text-muted-foreground" />
                  )}
                </button>
                <div className="space-y-1">
                  <div className="font-medium">{v.title}</div>
                  <div className={v.damage ? 'text-sm font-semibold text-destructive' : 'text-sm text-muted-foreground'}>{formatDamage(v.damage)}</div>
                  <div className="text-xs text-muted-foreground">{formatDate(v.createdAt)}</div>
                </div>
                <Button size="sm" variant="destructive" onClick={() => handleDelete(v.id, idx)}>
                  <Trash2 className="size-3.5" /> Удалить
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
