import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingCard } from './SettingCard'
import { getSupervisors, saveSupervisors } from '@/pages/docs/builders'
import { Avatar, Empty } from './ui'
import { Plus, UserCog, X } from 'lucide-react'

// Список «Начальники смен» — тот же localStorage-ключ (`memos_supervisors`),
// что и у выпадающего поля «Начальник смены (составил)» в служебных записках
// (ConsolidationPage.jsx): правки здесь сразу видны там.
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
    <SettingCard icon={UserCog} title="Начальники смен" subtitle="Варианты для поля «Начальник смены (составил)» в служебных записках">
      <form className="mb-4 flex gap-2" onSubmit={e => { e.preventDefault(); addSupervisor() }}>
        <Input className="max-w-xs" placeholder="Иванов И.И." value={input} onChange={e => setInput(e.target.value)} />
        <Button type="submit" variant="outline" disabled={!input.trim()}><Plus className="size-4" /> Добавить</Button>
      </form>

      {supervisors.length === 0 ? (
        <Empty>Список пуст — добавьте первого начальника смены</Empty>
      ) : (
        <div className="flex flex-wrap gap-2">
          {supervisors.map((name, i) => (
            <span key={name + i} className="group inline-flex items-center gap-2 rounded-full border border-line bg-surface py-1 pr-1 pl-1 text-sm shadow-card">
              <Avatar name={name} className="size-6 rounded-full text-[10px]" />
              {name}
              <button
                type="button"
                onClick={() => removeSupervisor(i)}
                title="Убрать из списка"
                className="grid size-6 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <X className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}
    </SettingCard>
  )
}
