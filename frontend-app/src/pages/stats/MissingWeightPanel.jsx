import { useEffect, useRef, useState } from 'react'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { RefreshCw, Download } from 'lucide-react'

// Перенесено из оригинала («Неучтённый вес» в StatsPage.jsx) — сверка ВГХ:
// запускает фоновую .NET-задачу на бэкенде и опрашивает статус каждые 3с.
export function MissingWeightPanel() {
  const [items, setItems] = useState([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const pollRef = useRef(null)

  useEffect(() => {
    api.getMissingWeight().then(setItems).catch(err => setError(err.message || 'Не удалось загрузить данные'))
    return () => clearInterval(pollRef.current)
  }, [])

  const rebuild = async () => {
    setRunning(true)
    setError('')
    try {
      await api.rebuildMissingWeight()
      pollRef.current = setInterval(async () => {
        try {
          const status = await api.getMissingWeightStatus()
          if (!status.running) {
            clearInterval(pollRef.current)
            setRunning(false)
            try {
              setItems(await api.getMissingWeight())
            } catch (err) {
              setError(err.message || 'Не удалось загрузить данные')
            }
          }
        } catch {
          clearInterval(pollRef.current)
          setRunning(false)
        }
      }, 3000)
    } catch (err) {
      setError(err.message || 'Не удалось запустить сверку')
      setRunning(false)
    }
  }

  const handleDownload = () => {
    const csv = ['Товар;Артикул', ...items.map(i => `${i.name};${i.article}`)].join('\r\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'missing-weight.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
      <span className="text-sm">
        {running ? 'Сверка ВГХ выполняется...' : error ? error : items.length ? `Неучтённый вес: ${items.length} товаров` : 'Неучтённого веса не найдено'}
      </span>
      <Button size="sm" variant="secondary" onClick={rebuild} disabled={running}>
        <RefreshCw className={`size-3.5 ${running ? 'animate-spin' : ''}`} /> Сверить ВГХ
      </Button>
      {items.length > 0 && (
        // Оригинал отдаёт настоящий .xlsx (backend); здесь — CSV с тем же
        // содержимым: XLSX-экспорт по всей странице сознательно отложен
        // (см. PLAN.md), а честный CSV лучше, чем кнопка с чужим лейблом.
        <Button size="sm" variant="secondary" onClick={handleDownload}>
          <Download className="size-3.5" /> Скачать CSV
        </Button>
      )}
    </div>
  )
}
