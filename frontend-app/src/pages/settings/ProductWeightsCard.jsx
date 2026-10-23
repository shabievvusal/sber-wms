import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { getStoredToken, fillWeightsFromWms } from '@/lib/wmsFetch'
import { withMinDuration } from '@/lib/timing'
import { Button } from '@/components/ui/button'
import { SettingCard } from './SettingCard'
import { IconAction } from './ui'
import { CloudDownload, FileSpreadsheet, Scale, Search, Square, Trash2, Upload } from 'lucide-react'
import { confirmDialog } from '@/components/ui/confirm'

function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function ProductWeightsCard() {
  const [info, setInfo] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Дозапрос весов из WMS для товаров, которых нет в Excel
  const [missing, setMissing] = useState(null)
  const [searching, setSearching] = useState(false)
  const [filling, setFilling] = useState(false)
  const [progress, setProgress] = useState(null)
  const [fillResult, setFillResult] = useState(null)
  const stopRef = useRef(false)

  const handleFindMissing = async () => {
    setSearching(true)
    setFillResult(null)
    try {
      const res = await withMinDuration(() => api.getMissingWeightProducts())
      setMissing(res?.items || [])
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setSearching(false)
    }
  }

  const handleFill = async () => {
    if (!getStoredToken()) { toast.error('Нет активного WMS-токена — войдите паролем от WMS'); return }
    stopRef.current = false
    setFilling(true)
    setProgress({ checked: 0, total: missing.length, found: 0, notFound: 0 })
    try {
      const res = await fillWeightsFromWms(missing, { onProgress: setProgress, shouldStop: () => stopRef.current })
      setFillResult(res)
      setMissing(res.notFound)
      toast.success(`Веса из WMS: сохранено ${res.saved}, без веса ${res.notFound.length}`)
      await loadInfo()
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setFilling(false)
    }
  }

  const downloadNotFound = () => {
    const lines = ['Артикул;Товар;Причина', ...(fillResult?.notFound || []).map(n => [n.code, n.name, n.reason].map(v => String(v || '').replace(/;/g, ',')).join(';'))]
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a'); a.href = url; a.download = 'товары_без_веса.csv'; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

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
    if (!(await confirmDialog({ title: 'Удалить файл весов товаров?', description: 'Без него в статистике не посчитается вес операций. Действие нельзя отменить — понадобится загрузить файл заново.', confirmText: 'Удалить', danger: true }))) return
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
              <div className="text-xs text-muted-foreground">обновлено {fmtDateTime(info.updatedAt)} · {(info.sizeBytes / 1024).toFixed(0)} КБ{info.wmsCount ? ` · из WMS: ${info.wmsCount.toLocaleString('ru-RU')}` : ''}</div>
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
      <div className="mt-3 rounded-2xl border p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <CloudDownload className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Дозаполнить из WMS</span>
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="outline" disabled={searching || filling} onClick={handleFindMissing}>
              <Search className="size-3.5" /> {searching ? 'Поиск…' : 'Найти без веса'}
            </Button>
            {filling
              ? <Button size="sm" variant="outline" onClick={() => { stopRef.current = true }}><Square className="size-3.5" /> Стоп</Button>
              : missing?.length > 0 && <Button size="sm" onClick={handleFill}>Запросить ({missing.length.toLocaleString('ru-RU')})</Button>}
          </div>
        </div>
        {missing && !filling && !fillResult && (
          <div className="mt-2 text-xs text-muted-foreground">
            {missing.length ? `Без веса: ${missing.length.toLocaleString('ru-RU')} товаров за 120 дней (сначала самые частые)` : 'Все товары за 120 дней с весом'}
          </div>
        )}
        {filling && progress && (
          <div className="mt-2 text-xs text-muted-foreground">
            Проверено {progress.checked} из {progress.total} · найден вес: {progress.found} · без веса: {progress.notFound}
          </div>
        )}
        {fillResult && !filling && (
          <div className="mt-2 text-xs text-muted-foreground">
            Сохранено весов: {fillResult.saved} · не нашлось: {fillResult.notFound.length}
            {fillResult.notFound.length > 0 && <button type="button" className="ml-2 font-medium text-primary" onClick={downloadNotFound}>скачать список</button>}
          </div>
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Вес из WMS — карточка товара (вес единицы). Вес из Excel главнее: из WMS дописываются только отсутствующие артикулы, новая загрузка Excel их не стирает.
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Нужны колонки <span className="font-medium text-foreground">«Артикул товара»</span> и <span className="font-medium text-foreground">«Вес товара»</span>. Вес — в кг (0.5) или граммах (500г).
      </p>
    </SettingCard>
  )
}
