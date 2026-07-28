import { useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingCard } from './SettingCard'
import { Trash2, Search, TriangleAlert } from 'lucide-react'

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

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
    const confirmed = confirm(
      `Удалить ${shiftLabel} смену за ${date}?\n\n` +
      `Операции: ${counts.ops}\nРаскладка: ${counts.placement}\nПриёмка: ${counts.receiving}\nОстатки: ${counts.remains}\nИтого: ${counts.total}\n\n` +
      `Это необратимо, резервной копии не будет.`
    )
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
      title="Удаление данных за смену"
      subtitle="Безвозвратно удаляет статистику за выбранную смену сразу из всех 4 доменов (операции, раскладка, приёмка, остатки)"
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-[3px]">
          <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Дата</label>
          <Input
            type="date" value={date} className="w-40"
            onChange={e => { setDate(e.target.value); resetCheck() }}
          />
        </div>
        <div className="flex flex-col gap-[3px]">
          <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Смена</label>
          <select
            value={shift}
            onChange={e => { setShift(e.target.value); resetCheck() }}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
          >
            <option value="day">Дневная</option>
            <option value="night">Ночная</option>
          </select>
        </div>
        <Button size="sm" variant="outline" disabled={checking || deleting} onClick={handleCheck}>
          <Search /> {checking ? 'Проверяем...' : 'Проверить'}
        </Button>
        {canDelete && (
          <Button size="sm" variant="destructive" disabled={deleting} onClick={handleDelete}>
            <Trash2 /> {deleting ? 'Удаление...' : `Удалить (${counts.total})`}
          </Button>
        )}
      </div>

      {counts && (
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Операции</div>
            <div className="text-lg font-semibold">{counts.ops}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Раскладка</div>
            <div className="text-lg font-semibold">{counts.placement}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Приёмка</div>
            <div className="text-lg font-semibold">{counts.receiving}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Остатки</div>
            <div className="text-lg font-semibold">{counts.remains}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Итого</div>
            <div className="text-lg font-semibold text-primary">{counts.total}</div>
          </div>
        </div>
      )}

      <p className="mt-4 flex items-start gap-1.5 text-xs text-muted-foreground">
        <TriangleAlert size={14} className="mt-0.5 shrink-0" />
        Удаление необратимо, резервной копии не создаётся. Кнопка «Удалить» появляется только сразу после «Проверить» для той же даты и смены.
      </p>
    </SettingCard>
  )
}
