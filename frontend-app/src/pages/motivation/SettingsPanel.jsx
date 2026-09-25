import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

function NumField({ label, value, onChange, step = 1, disabled }) {
  return (
    <label className="space-y-1 text-sm">
      <span className="block text-xs text-muted-foreground">{label}</span>
      <Input type="number" min="0" step={step} className="h-8" value={value} disabled={disabled}
        onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
    </label>
  )
}

// Нормы мотивации. Менять может только admin/developer (бэкенд проверяет
// сам, здесь поля просто заблокированы для остальных).
export function SettingsPanel({ settings, canEdit, onSaved }) {
  const [form, setForm] = useState(settings)
  const [saving, setSaving] = useState(false)
  useEffect(() => setForm(settings), [settings])

  const set = (path, value) => setForm(prev => {
    const [a, b] = path.split('.')
    return b ? { ...prev, [a]: { ...prev[a], [b]: value } } : { ...prev, [a]: value }
  })

  const save = async () => {
    setSaving(true)
    try {
      const data = await api.saveMotivationSettings(form)
      toast.success('Нормы сохранены')
      onSaved(data.settings)
    } catch (err) {
      toast.error(err.message)
    }
    setSaving(false)
  }

  const ro = !canEdit
  return (
    <div className="space-y-4 rounded-lg border bg-card p-3">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <div className="text-sm font-semibold">Чистое хранение</div>
          <div className="grid grid-cols-3 gap-2">
            <NumField label="СЗ за смену" value={form.storage.tasks} onChange={v => set('storage.tasks', v)} disabled={ro} />
            <NumField label="Вес, кг" value={form.storage.weightKg} onChange={v => set('storage.weightKg', v)} disabled={ro} />
            <NumField label="СЗ = 1 час" value={form.storage.tasksPerHour} onChange={v => set('storage.tasksPerHour', v)} disabled={ro} />
          </div>
        </div>
        <div className="space-y-2">
          <div className="text-sm font-semibold">Только КДК</div>
          <div className="grid grid-cols-3 gap-2">
            <NumField label="СЗ за смену" value={form.kdk.tasks} onChange={v => set('kdk.tasks', v)} disabled={ro} />
            <NumField label="Вес, кг" value={form.kdk.weightKg} onChange={v => set('kdk.weightKg', v)} disabled={ro} />
            <NumField label="СЗ = 1 час" value={form.kdk.tasksPerHour} onChange={v => set('kdk.tasksPerHour', v)} disabled={ro} />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <NumField label="Часов за норму" step={0.5} value={form.baseHours} onChange={v => set('baseHours', v)} disabled={ro} />
        <NumField label="Шаг округления, ч" step={0.5} value={form.roundStep} onChange={v => set('roundStep', v)} disabled={ro} />
        <NumField label="Максимум часов" step={0.5} value={form.maxHours} onChange={v => set('maxHours', v)} disabled={ro} />
        <label className="space-y-1 text-sm">
          <span className="block text-xs text-muted-foreground">Срок учёток, день</span>
          <Input type="time" className="h-8" value={form.dayDeadline} disabled={ro} onChange={e => set('dayDeadline', e.target.value)} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block text-xs text-muted-foreground">Срок учёток, ночь</span>
          <Input type="time" className="h-8" value={form.nightDeadline} disabled={ro} onChange={e => set('nightDeadline', e.target.value)} />
        </label>
      </div>
      <div className="flex flex-wrap gap-6 text-sm">
        <label className="flex items-center gap-2">
          <Switch checked={form.bonusEnabled} disabled={ro} onCheckedChange={v => set('bonusEnabled', v)} />
          Перевыполнение добавляет часы (до максимума)
        </label>
        <label className="flex items-center gap-2">
          <Switch checked={form.strictDeadline} disabled={ro} onCheckedChange={v => set('strictDeadline', v)} />
          Учётка после срока не засчитывается
        </label>
      </div>
      <div className="text-xs text-muted-foreground">
        Засчитывается меньшее из выполнения по СЗ и по весу. При смешанной работе доли складываются: 450 СЗ хранения + 750 СЗ КДК = 100%.
        Недобор снимается только полными шагами (в пользу работника), перевыполнение добавляется тоже полными шагами.
      </div>
      {canEdit && <Button size="sm" onClick={save} disabled={saving}>Сохранить нормы</Button>}
    </div>
  )
}
