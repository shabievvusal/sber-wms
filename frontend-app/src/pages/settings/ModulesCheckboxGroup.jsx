import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Выбор модулей / действий — чипы-переключатели вместо сетки чекбоксов
 * (MyModulesCard, RolesCard, EditUserDialog). Сверху — счётчик и
 * «Все / Снять», если передан onSetAll.
 */
export function ModulesCheckboxGroup({ items, labels, selected, onToggle, onSetAll }) {
  return (
    <div className="space-y-2">
      {onSetAll && (
        <div className="flex items-center gap-3 text-xs">
          <span className="text-muted-foreground">Выбрано {items.filter(k => selected.has(k)).length} из {items.length}</span>
          <button type="button" className="font-medium text-brand hover:underline" onClick={() => onSetAll(true)}>Все</button>
          <button type="button" className="font-medium text-muted-foreground hover:text-foreground hover:underline" onClick={() => onSetAll(false)}>Снять</button>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {items.map(key => {
          const on = selected.has(key)
          return (
            <button
              key={key}
              type="button"
              role="checkbox"
              aria-checked={on}
              onClick={() => onToggle(key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors',
                on
                  ? 'border-transparent bg-brand-soft font-medium text-brand'
                  : 'border-line bg-surface text-ink-2 hover:border-line-strong hover:text-foreground',
              )}
            >
              <span className={cn('grid size-4 place-items-center rounded-full transition-colors', on ? 'bg-brand text-white' : 'border border-line-strong')}>
                {on && <Check className="size-3" strokeWidth={3} />}
              </span>
              {labels[key] || key}
            </button>
          )
        })}
      </div>
    </div>
  )
}
