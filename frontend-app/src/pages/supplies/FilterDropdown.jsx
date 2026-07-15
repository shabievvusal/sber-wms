import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { ChevronDown, X } from 'lucide-react'

/**
 * Общий чек-бокс-фильтр (Статус/Тип/Температура в оригинале). В оригинале был
 * draft-state с кнопками «Применить»/«Сбросить» — на моках фильтрация мгновенная
 * и бесплатная, поэтому здесь применяется сразу по клику, без лишнего шага.
 */
export function FilterDropdown({ label, options, selected, onChange }) {
  const toggle = value => onChange(selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value])

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant={selected.length ? 'default' : 'outline'} className="gap-1.5">
          {label}{selected.length > 0 && ` (${selected.length})`}
          {selected.length > 0 ? (
            <span role="button" tabIndex={-1} className="ml-0.5 rounded-sm opacity-80 hover:opacity-100" onClick={e => { e.stopPropagation(); onChange([]) }}>
              <X className="size-3.5" />
            </span>
          ) : (
            <ChevronDown className="size-3.5 opacity-70" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2">
        <div className="max-h-72 space-y-0.5 overflow-y-auto">
          {options.map(o => (
            <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
              <Checkbox checked={selected.includes(o.value)} onCheckedChange={() => toggle(o.value)} />
              {o.label}
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
