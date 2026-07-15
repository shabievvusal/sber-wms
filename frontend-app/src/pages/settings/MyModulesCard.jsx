import { useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { SettingCard } from './SettingCard'
import { ModulesCheckboxGroup } from './ModulesCheckboxGroup'
import { ALL_MODULES, VS_MODULE_LABELS } from './constants'
import { UserCircle } from 'lucide-react'

export function MyModulesCard({ currentUser }) {
  const [selected, setSelected] = useState(() => new Set(currentUser?.modules || []))
  const [saving, setSaving] = useState(false)

  const toggle = m => setSelected(prev => {
    const next = new Set(prev)
    next.has(m) ? next.delete(m) : next.add(m)
    return next
  })

  const handleSave = async () => {
    if (!currentUser?.login) return
    setSaving(true)
    try {
      await api.putVsAdminUser(currentUser.login, { modules: [...selected] })
      toast.success('Разделы обновлены')
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingCard icon={UserCircle} title="Мои разделы" subtitle="Выберите разделы, которые отображаются в вашем меню">
      <ModulesCheckboxGroup items={ALL_MODULES} labels={VS_MODULE_LABELS} selected={selected} onToggle={toggle} />
      <div className="pt-4">
        <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? 'Сохранение...' : 'Сохранить'}</Button>
      </div>
    </SettingCard>
  )
}
