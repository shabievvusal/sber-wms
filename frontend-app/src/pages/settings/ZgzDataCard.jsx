import { useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { Button } from '@/components/ui/button'
import { DateRangePicker } from '@/components/ui/date-picker'
import { confirmDialog } from '@/components/ui/confirm'
import { SettingCard } from './SettingCard'
import { Field } from './ui'
import { ScanSearch, Search, Trash2 } from 'lucide-react'

const fmtDate = d => (d ? d.split('-').reverse().join('.') : '')

// Только admin/developer (см. SettingsPage.jsx) — очистка переводов ЕО в ЗГЗ,
// сохранённых для «Поиска потеряшек»: за период (даты перевода, МСК) или всё.
export function ZgzDataCard() {
  const [range, setRange] = useState({ from: '', to: '' })
  const [checking, setChecking] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [count, setCount] = useState(null)
  const [checkedFor, setCheckedFor] = useState(null)

  const from = range.from
  const to = range.to || range.from
  const periodLabel = from ? (from === to ? fmtDate(from) : `${fmtDate(from)} — ${fmtDate(to)}`) : 'весь период'
  const key = `${from}|${to}`
  // удалять — только сразу после подсчёта того же периода
  const canDelete = count != null && checkedFor === key

  const handleCheck = async () => {
    setChecking(true)
    try {
      const res = await withMinDuration(() => api.getZgzCount(from, to))
      setCount(res.rows)
      setCheckedFor(key)
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setChecking(false)
    }
  }

  const handleDelete = async () => {
    const confirmed = await confirmDialog({
      title: `Удалить переводы в ЗГЗ: ${periodLabel}?`,
      description: `Строк: ${count.toLocaleString('ru-RU')}. Поиск потеряшек за этот период станет пустым, пока не загрузить переводы из WMS заново.`,
      confirmText: `Удалить ${count.toLocaleString('ru-RU')} строк`,
      danger: true,
    })
    if (!confirmed) return
    setDeleting(true)
    try {
      const res = await withMinDuration(() => api.deleteZgz(from, to))
      toast.success(`Удалено строк: ${res.deleted.toLocaleString('ru-RU')}`)
      setCount(null)
      setCheckedFor(null)
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <SettingCard icon={ScanSearch} danger title="Данные поиска потеряшек" subtitle="Переводы ЕО в ЗГЗ, сохранённые на сервере для «Поиска потеряшек»">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Период перевода">
          <DateRangePicker className="w-56" from={range.from} to={range.to} onChange={r => { setRange(r); setCount(null); setCheckedFor(null) }} placeholder="Весь период" />
        </Field>
        <Button variant="outline" disabled={checking || deleting} onClick={handleCheck}>
          <Search className="size-4" /> {checking ? 'Считаю…' : 'Посчитать'}
        </Button>
        {canDelete && count > 0 && (
          <Button variant="destructive" disabled={deleting} onClick={handleDelete}>
            <Trash2 className="size-4" /> {deleting ? 'Удаление…' : `Удалить ${count.toLocaleString('ru-RU')} строк`}
          </Button>
        )}
      </div>
      {canDelete && (
        <div className="mt-3 text-sm text-muted-foreground">
          {count > 0 ? `${periodLabel}: строк ${count.toLocaleString('ru-RU')}` : `${periodLabel}: данных нет — удалять нечего`}
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Без выбранного периода — удаляется всё. Кнопка удаления появляется только после подсчёта для того же периода.
      </p>
    </SettingCard>
  )
}
