import { useEffect, useState } from 'react'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { RefreshCw, Download } from 'lucide-react'

const DAYS = 120

// «Неучтённый вес» — товары из операций за последние 120 дней, у которых
// нет веса в справочнике. Считается в базе (dotnet /api/product-weights/missing)
// за секунды — без прежнего фонового пересчёта по почасовым JSON-файлам.
export function MissingWeightPanel() {
  const [items, setItems] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.getMissingWeightProducts(DAYS)
      setItems(res?.items || [])
    } catch (err) {
      setError(err.message || 'Не удалось загрузить данные')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const handleDownload = () => {
    const csv = ['Товар;Артикул;Операций', ...(items || []).map(i => `${String(i.name || '').replace(/;/g, ',')};${i.code};${i.uses}`)].join('\r\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'неучтённый_вес.csv'; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-card shadow-card p-3">
      <span className="text-sm">
        {loading ? 'Сверка ВГХ…' : error ? error : items?.length ? `Неучтённый вес: ${items.length} товаров за ${DAYS} дней` : items ? 'Неучтённого веса не найдено' : ''}
      </span>
      <Button size="sm" variant="secondary" onClick={load} disabled={loading}>
        <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} /> Сверить ВГХ
      </Button>
      {items?.length > 0 && (
        <Button size="sm" variant="secondary" onClick={handleDownload}>
          <Download className="size-3.5" /> Скачать CSV
        </Button>
      )}
    </div>
  )
}
