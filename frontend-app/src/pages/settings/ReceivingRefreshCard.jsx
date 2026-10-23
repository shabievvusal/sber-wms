import { useState } from 'react'
import { toast } from 'sonner'
import { getStoredToken, fetchReceivingViaBrowser, mergeNewEmployees } from '@/lib/wmsFetch'
import { NewEmployeesNotice } from './NewEmployeesNotice'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import { SettingCard } from './SettingCard'
import { Field } from './ui'
import { PackageCheck, RefreshCw } from 'lucide-react'

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Сутки по Москве, 00:00–24:00 — поставки сохраняются по времени
// завершения, на смены их делит только статистика.
function dayRange(date) {
  const from = new Date(`${date}T00:00:00+03:00`)
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000 - 1)
  return { completedDateFrom: from.toISOString(), completedDateTo: to.toISOString() }
}

// Только admin/developer (см. SettingsPage.jsx). Статистика приёмки не входит
// в обычное «Обновить данные»: чтобы узнать приёмщика, WMS нужно спросить по
// каждой поставке отдельно — обновляем вручную, по одному дню.
export function ReceivingRefreshCard() {
  const [date, setDate] = useState(todayStr())
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [result, setResult] = useState(null)
  const [newEmployees, setNewEmployees] = useState([])

  const handleRun = async () => {
    const token = getStoredToken()
    if (!token) { toast.error('Нет активного WMS-токена — войдите паролем от WMS'); return }
    setRunning(true)
    setProgress(null)
    setResult(null)
    try {
      const res = await fetchReceivingViaBrowser(token, { ...dayRange(date), onProgress: setProgress })
      setResult(res)
      if (res.newEmployees?.length) setNewEmployees(prev => mergeNewEmployees(prev, res.newEmployees))
      toast.success(`Приёмка обновлена: поставок ${res.fetched}, новых сохранено ${res.saved}`)
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <SettingCard
      icon={PackageCheck}
      title="Статистика приёмки"
      subtitle="Загружает принятые за день поставки из WMS: поставки, ЕО, SKU, штуки и вес по приёмщикам"
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Дата">
          <DatePicker className="w-44" value={date} onChange={e => setDate(e.target.value)} />
        </Field>
        <Button variant="outline" disabled={running} onClick={handleRun}>
          <RefreshCw className={running ? 'size-4 animate-spin' : 'size-4'} /> {running ? 'Загрузка…' : 'Обновить приёмку'}
        </Button>
      </div>

      {running && progress && (
        <div className="mt-3 text-sm text-muted-foreground">
          Поставок: {progress.total}, уже в базе: {progress.known} · приёмщики: {progress.done} из {progress.toEnrich}
        </div>
      )}
      {result && (
        <div className="mt-3 text-sm text-muted-foreground">
          Поставок за день: {result.fetched} · уже были в базе: {result.known} · запрошено у WMS: {result.requested} · сохранено: {result.saved}
          {result.noAcceptor > 0 && ` · без приёмщика: ${result.noAcceptor}`}
        </div>
      )}

      <NewEmployeesNotice employees={newEmployees} onDone={() => setNewEmployees([])} />

      <p className="mt-4 text-xs text-muted-foreground">
        По каждой новой поставке — отдельный запрос в WMS за приёмщиком. Поставки, которые уже сохранены, повторно не запрашиваются.
      </p>
    </SettingCard>
  )
}
