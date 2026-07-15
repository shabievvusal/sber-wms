import { Button } from '@/components/ui/button'
import { TaskTypeBadge } from './TaskTypeBadge'
import { shortFio } from './format'
import { Lightbulb } from 'lucide-react'

/** Люди, замеченные в живых данных, но не отмеченные на перекличке. */
export function SuggestionsSection({ suggestions, onAdd, onAddAll }) {
  if (!suggestions.length) return null
  return (
    <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/5 p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Lightbulb className="size-4 text-warning" />
        Обнаружены в системе, но не в перекличке ({suggestions.length})
      </div>
      <div className="space-y-1.5">
        {suggestions.map(s => (
          <div key={s.executorId} className="flex flex-wrap items-center gap-2 rounded-md bg-card px-3 py-2 text-sm">
            <span className="min-w-32 font-medium" title={s.displayFio}>{shortFio(s.displayFio)}</span>
            <span className="text-muted-foreground">{s.company}</span>
            {s.taskType && <TaskTypeBadge type={s.taskType} />}
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => onAdd(s.executorId)}>+ Добавить</Button>
          </div>
        ))}
      </div>
      <Button size="sm" onClick={onAddAll}>Добавить всех ({suggestions.length})</Button>
    </div>
  )
}
