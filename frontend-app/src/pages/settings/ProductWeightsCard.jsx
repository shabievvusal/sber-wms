import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { Button } from '@/components/ui/button'
import { SettingCard } from './SettingCard'
import { IconAction } from './ui'
import { FileSpreadsheet, Scale, Trash2, Upload } from 'lucide-react'

function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function ProductWeightsCard() {
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
    <SettingCard icon={Scale} title="Веса товаров" subtitle="Для расчёта веса в статистике">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface-2/60 p-3.5">
        <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${info?.exists ? 'bg-success/12 text-success' : 'bg-surface-3 text-muted-foreground'}`}>
          <FileSpreadsheet className="size-5" />
        </span>
        <div className="min-w-0 flex-1 basis-48">
          {info?.exists ? (
            <>
              <div className="tabular text-sm font-medium">{info.count.toLocaleString('ru-RU')} артикулов</div>
              <div className="text-xs text-muted-foreground">обновлено {fmtDateTime(info.updatedAt)} · {(info.sizeBytes / 1024).toFixed(0)} КБ</div>
            </>
          ) : (
            <>
              <div className="text-sm font-medium">{info ? 'Файл не загружен' : 'Загрузка…'}</div>
              <div className="text-xs text-muted-foreground">Без весов в статистике не посчитается вес операций</div>
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          {info?.exists && <IconAction icon={Trash2} title="Удалить файл весов" tone="danger" disabled={deleting || uploading} onClick={handleDelete} />}
          <Button size="sm" variant={info?.exists ? 'outline' : 'default'} disabled={uploading} asChild>
            <label className="cursor-pointer">
              <Upload className="size-3.5" /> {uploading ? 'Загрузка…' : info?.exists ? 'Заменить' : 'Загрузить Excel'}
              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={handleUpload} disabled={uploading} />
            </label>
          </Button>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Нужны колонки <span className="font-medium text-foreground">«Артикул товара»</span> и <span className="font-medium text-foreground">«Вес товара»</span>. Вес — в кг (0.5) или граммах (500г).
      </p>
    </SettingCard>
  )
}
