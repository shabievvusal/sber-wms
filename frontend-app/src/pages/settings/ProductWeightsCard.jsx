import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { Button } from '@/components/ui/button'
import { SettingCard } from './SettingCard'
import { Scale, Upload, Trash2 } from 'lucide-react'

function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function ProductWeightsCard() {
  const fileRef = useRef(null)
  const [info, setInfo] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const loadInfo = () => api.getProductWeightsInfo().then(setInfo).catch(() => setInfo({ exists: false }))

  useEffect(() => { loadInfo() }, [])

  const handleUpload = async e => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      await withMinDuration(async () => {
        const res = await api.uploadProductWeightsExcel(file)
        toast.success(`Загружено ${res.count} артикулов`)
      })
      await loadInfo()
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const handleDelete = async () => {
    if (!confirm('Удалить файл весов товаров? Это действие нельзя отменить.')) return
    setDeleting(true)
    try {
      await withMinDuration(async () => { await api.deleteProductWeightsExcel() })
      toast.success('Файл весов удалён')
      await loadInfo()
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <SettingCard
      icon={Scale}
      title="Веса товаров"
      subtitle={info?.exists
        ? `${info.count} артикулов · обновлено ${fmtDateTime(info.updatedAt)} · ${(info.sizeBytes / 1024).toFixed(0)} КБ`
        : 'Файл не загружен'}
      actions={
        <>
          {info?.exists && (
            <Button variant="destructive" size="sm" disabled={deleting || uploading} onClick={handleDelete}>
              <Trash2 /> {deleting ? 'Удаление...' : 'Удалить'}
            </Button>
          )}
          <Button size="sm" disabled={uploading} asChild>
            <label className="cursor-pointer">
              <Upload /> {uploading ? 'Загрузка...' : 'Загрузить Excel'}
              <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleUpload} disabled={uploading} />
            </label>
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        Файл должен содержать колонки <strong className="text-foreground">«Артикул товара»</strong> и{' '}
        <strong className="text-foreground">«Вес товара»</strong>. Вес указывается в кг (например: 0.5) или граммах (например: 500г).
      </p>
    </SettingCard>
  )
}
