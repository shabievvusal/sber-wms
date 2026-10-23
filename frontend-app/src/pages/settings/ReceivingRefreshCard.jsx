import { useState } from 'react'
import { toast } from 'sonner'
import { getStoredToken, fetchReceivingViaBrowser } from '@/lib/wmsFetch'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import { Select } from '@/components/ui/select'
import { SettingCard } from './SettingCard'
import { Field } from './ui'
import { PackageCheck, RefreshCw } from 'lucide-react'

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Границы смены в МСК: день 09:00–21:00, ночь 21:00–09:00 следующего дня.
function shiftRange(date, shift) {
  const from = new Date(`${date}T${shift === 'night' ? '21' : '09'}:00:00+03:00`)
  const to = new Date(from.getTime() + 12 * 60 * 60 * 1000 - 1)
  return { completedDateFrom: from.toISOString(), completedDateTo: to.toISOString() }
}

// Только admin/developer (см. SettingsPage.jsx). Статистика приёмки не входит
// в обычное «Обновить данные»: чтобы узнать приёмщика, WMS нужно спросить по
// каждой поставке отдельно — обновляем вручную, по одной смене.
export function ReceivingRefreshCard() {
  const [date, setDate] = useState(todayStr())
  const [shift, setShift] = useState('day')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [result, setResult] = useState(null)

  const handleRun = async () => {
    const token = getStoredToken()
    if (!token) { toast.error('Нет активного WMS-токена — войдите паролем от WMS'); return }
    setRunning(true)
    setProgress(null)
    setResult(null)
    try {
      const res = await fetchReceivingViaBrowser(token, { ...shiftRange(date, shift), onProgress: setProgress })
      setResult(res)
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
      subtitle="Загружает принятые поставки смены из WMS: поставки, ЕО, SKU, штуки и вес по приёмщикам"
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Дата">
          <DatePicker className="w-44" value={date} onChange={e => setDate(e.target.value)} />
        </Field>
        <Field label="Смена">
          <Select className="w-36" value={shift} onChange={e => setShift(e.target.value)}>
            <option value="day">Дневная</option>
            <option value="night">Ночная</option>
          </Select>
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
          Поставок за смену: {result.fetched} · уже были в базе: {result.known} · запрошено у WMS: {result.requested} · сохранено: {result.saved}
          {result.noAcceptor > 0 && ` · без приёмщика: ${result.noAcceptor}`}
        </div>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        По каждой новой поставке — отдельный запрос в WMS за приёмщиком. Поставки, которые уже сохранены, повторно не запрашиваются.
      </p>
    </SettingCard>
  )
}
