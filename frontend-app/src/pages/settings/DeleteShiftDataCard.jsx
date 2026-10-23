import { useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import { Select } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { SettingCard } from './SettingCard'
import { Field } from './ui'
import { Search, Trash2, TriangleAlert } from 'lucide-react'
import { confirmDialog } from '@/components/ui/confirm'

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const DOMAINS = [
  { key: 'ops', label: 'Операции' },
  { key: 'placement', label: 'Раскладка' },
  { key: 'receiving', label: 'Приёмка' },
  { key: 'remains', label: 'Остатки' },
  { key: 'stockMoves', label: 'Спуск/пополнение/размещение' },
]

// Только admin/developer (см. SettingsPage.jsx) — безвозвратное удаление
// боевых данных сразу из 4 доменов статистики (wms_ops/placement/receiving/
// remains), появилось после того, как повторный прогон «обновить данные за
// все часы» наплодил дубли в «Хранении» и понадобился способ почистить
// конкретную смену без захода в Docker-контейнер с Postgres.
export function DeleteShiftDataCard() {
  const [date, setDate] = useState(todayStr())
  const [shift, setShift] = useState('day')
  const [checking, setChecking] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [counts, setCounts] = useState(null)
  const [checkedFor, setCheckedFor] = useState(null)

  const resetCheck = () => { setCounts(null); setCheckedFor(null) }

  const handleCheck = async () => {
    setChecking(true)
    setCounts(null)
    try {
      const data = await withMinDuration(() => api.getShiftDataCount(date, shift))
      setCounts(data)
      setCheckedFor({ date, shift })
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setChecking(false)
    }
  }

  // Кнопка удаления активна только сразу после проверки ТОЙ ЖЕ даты/смены —
  // если что-то поменяли в форме, значит числа на экране больше не про то,
  // что реально будет удалено, и удалять не глядя нельзя.
  const canDelete = !!(counts && checkedFor && checkedFor.date === date && checkedFor.shift === shift)

  const handleDelete = async () => {
    if (!canDelete) return
    const shiftLabel = shift === 'day' ? 'дневную' : 'ночную'
    const confirmed = await confirmDialog({
      title: `Удалить ${shiftLabel} смену за ${date.split('-').reverse().join('.')}?`,
      description:
        `Операции: ${counts.ops}\nРаскладка: ${counts.placement}\nПриёмка: ${counts.receiving}\nОстатки: ${counts.remains}\nСпуск/пополнение/размещение: ${counts.stockMoves ?? 0}\nВсего: ${counts.total}\n\n` +
        `Это необратимо, резервной копии не будет.`,
      confirmText: `Удалить ${counts.total} записей`,
      danger: true,
    })
    if (!confirmed) return
    setDeleting(true)
    try {
      const result = await withMinDuration(() => api.deleteShiftData(date, shift))
      toast.success(`Удалено записей: ${result.total}`)
      resetCheck()
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <SettingCard
      icon={Trash2}
      danger
      title="Удаление данных за смену"
      subtitle="Безвозвратно стирает статистику смены сразу из операций, раскладки, приёмки и остатков"
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Дата">
          <DatePicker className="w-44" value={date} onChange={e => { setDate(e.target.value); resetCheck() }} />
        </Field>
        <Field label="Смена">
          <Select className="w-36" value={shift} onChange={e => { setShift(e.target.value); resetCheck() }}>
            <option value="day">Дневная</option>
            <option value="night">Ночная</option>
          </Select>
        </Field>
        <Button variant="outline" disabled={checking || deleting} onClick={handleCheck}>
          <Search className="size-4" /> {checking ? 'Считаю…' : 'Посчитать записи'}
        </Button>
      </div>

      {counts && (
        <div className="mt-4 rounded-2xl border border-destructive/20 bg-destructive/[0.04] p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {DOMAINS.map(d => (
              <div key={d.key}>
                <div className="text-xs text-muted-foreground">{d.label}</div>
                <div className="tabular text-xl font-semibold tracking-tight">{Number(counts[d.key] || 0).toLocaleString('ru-RU')}</div>
              </div>
            ))}
            <div>
              <div className="text-xs text-muted-foreground">Всего</div>
              <div className={cn('tabular text-xl font-semibold tracking-tight', counts.total ? 'text-destructive' : '')}>{Number(counts.total || 0).toLocaleString('ru-RU')}</div>
            </div>
          </div>
          {canDelete && counts.total > 0 && (
            <Button variant="destructive" className="mt-4" disabled={deleting} onClick={handleDelete}>
              <Trash2 className="size-4" /> {deleting ? 'Удаление…' : `Удалить ${Number(counts.total).toLocaleString('ru-RU')} записей`}
            </Button>
          )}
          {canDelete && !counts.total && <div className="mt-3 text-sm text-muted-foreground">За эту смену данных нет — удалять нечего.</div>}
        </div>
      )}

      <p className="mt-4 flex items-start gap-1.5 text-xs text-muted-foreground">
        <TriangleAlert size={14} className="mt-0.5 shrink-0 text-destructive" />
        Резервной копии не создаётся. Кнопка удаления появляется только после подсчёта для той же даты и смены.
      </p>
    </SettingCard>
  )
}
