import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingCard } from './SettingCard'
import { getSupervisors, saveSupervisors } from '@/pages/docs/builders'
import { UserCog, X } from 'lucide-react'

// Список «Начальники смен» для раздела «Документы» — уже управлялся прямо
// внутри DocsPage.jsx (шестерёнка настроек рядом с полем «Начальник смены
// (составил)»), но только оттуда. Пользователь попросил (2026-07-15) ту же
// возможность добавить в Настройки → Документы — тот же localStorage-ключ
// (`memos_supervisors`, общий с ConsolidationPage.jsx), просто ещё одна
// точка входа к тому же списку: правки здесь сразу видны и в DocsPage.jsx,
// и наоборот.
export function SupervisorsCard() {
  const [supervisors, setSupervisors] = useState(() => getSupervisors())
  const [input, setInput] = useState('')

  const addSupervisor = () => {
    const name = input.trim()
    if (!name) return
    const list = getSupervisors()
    if (list.includes(name)) { toast.error('Это ФИО уже в списке'); return }
    list.push(name)
    saveSupervisors(list)
    setSupervisors([...list])
    setInput('')
  }

  const removeSupervisor = idx => {
    const list = getSupervisors()
    list.splice(idx, 1)
    saveSupervisors(list)
    setSupervisors([...list])
  }

  return (
    <SettingCard icon={UserCog} title="Начальники смен" subtitle="Список для выпадающего поля «Начальник смены (составил)» в разделе «Документы»">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          className="h-8 w-56"
          placeholder="Иванов И.И."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSupervisor() } }}
        />
        <Button size="sm" onClick={addSupervisor}>+ Добавить</Button>
      </div>

      {supervisors.length === 0 ? (
        <div className="text-sm text-muted-foreground">Список пуст</div>
      ) : (
        <ul className="divide-y rounded-md border">
          {supervisors.map((name, i) => (
            <li key={i} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
              <span>{name}</span>
              <Button size="icon" variant="ghost" onClick={() => removeSupervisor(i)} title="Удалить"><X className="size-3.5" /></Button>
            </li>
          ))}
        </ul>
      )}
    </SettingCard>
  )
}
