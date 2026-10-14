import { useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * Ячейка «текст ↔ поле»: в покое — текст (дёшево даже в длинных списках),
 * по клику/фокусу — поле ввода со всем текстом выделенным. Изменение
 * применяется по Enter/уходу из поля, Escape — отмена. Tab переходит в
 * следующую ячейку и сразу открывает её на правку.
 *
 *   <EditableCell value={row.fio} placeholder="ФИО" onCommit={v => save(v)} />
 *
 * `display` — как показывать значение в покое (например, цветной меткой),
 * `list` — id <datalist> с подсказками (см. Input), `inputProps` — прочие
 * атрибуты поля (type, min…).
 */
export function EditableCell({ value, onCommit, placeholder, list, display, className, autoEdit, disabled, inputProps }) {
  const [editing, setEditing] = useState(!!autoEdit)
  const [draft, setDraft] = useState(value)
  const cancelled = useRef(false)

  const start = () => {
    if (disabled) return
    setDraft(value)
    cancelled.current = false
    setEditing(true)
  }
  const finish = () => {
    setEditing(false)
    if (!cancelled.current && draft !== value) onCommit(draft)
  }

  if (editing) {
    return (
      <Input
        autoFocus
        className={cn('h-8', className)}
        value={draft}
        list={list}
        placeholder={placeholder}
        {...inputProps}
        onChange={e => setDraft(e.target.value)}
        onFocus={e => e.currentTarget.select()}
        onBlur={finish}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur() }
        }}
      />
    )
  }

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      onClick={start}
      onFocus={start}
      title={disabled ? undefined : 'Нажмите, чтобы изменить'}
      className={cn(
        'group/cell flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-transparent px-2.5 text-sm transition-colors',
        disabled ? 'cursor-default' : 'cursor-text hover:border-line hover:bg-surface-2/60 focus-visible:border-ring focus-visible:outline-none',
        className,
      )}
    >
      {value
        ? <span className="min-w-0 truncate">{display ? display(value) : value}</span>
        : <span className="truncate text-muted-foreground">{placeholder}</span>}
      {!disabled && <Pencil className="ml-auto size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/cell:opacity-100" />}
    </div>
  )
}
