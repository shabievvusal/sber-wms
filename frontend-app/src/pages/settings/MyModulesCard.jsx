import { useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { SettingCard } from './SettingCard'
import { ModulesCheckboxGroup } from './ModulesCheckboxGroup'
import { ALL_MODULES, VS_MODULE_LABELS, knownModules } from './constants'
import { LayoutGrid, Save } from 'lucide-react'

const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x))

export function MyModulesCard({ currentUser }) {
  const [saved, setSaved] = useState(() => new Set(currentUser?.modules || []))
  const [selected, setSelected] = useState(() => new Set(currentUser?.modules || []))
  const [saving, setSaving] = useState(false)
  const dirty = !sameSet(saved, selected)

  const toggle = m => setSelected(prev => {
    const next = new Set(prev)
    next.has(m) ? next.delete(m) : next.add(m)
    return next
  })

  const handleSave = async () => {
    if (!currentUser?.login) return
    setSaving(true)
    try {
      await api.putVsAdminUser(currentUser.login, { modules: knownModules([...selected]) })
      setSaved(new Set(selected))
      toast.success('Разделы обновлены')
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingCard
      icon={LayoutGrid}
      title="Мои разделы"
      subtitle="Какие разделы показываются в вашем меню"
      actions={dirty && (
        <>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(saved))} disabled={saving}>Отменить</Button>
          <Button size="sm" onClick={handleSave} disabled={saving}><Save className="size-3.5" /> {saving ? 'Сохранение…' : 'Сохранить'}</Button>
        </>
      )}
    >
      <ModulesCheckboxGroup
        items={ALL_MODULES}
        labels={VS_MODULE_LABELS}
        selected={selected}
        onToggle={toggle}
        onSetAll={all => setSelected(all ? new Set(ALL_MODULES) : new Set())}
      />
    </SettingCard>
  )
}
