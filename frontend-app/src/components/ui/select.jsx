import * as React from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { Check, ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'

// Замена нативного <select>: выпадающий список браузера не стилизуется (на
// Windows — серая системная рамка с синей подсветкой и без тёмной темы),
// поэтому список рисуем сами, в стиле остального интерфейса.
//
// Интерфейс совместим с <select>, чтобы страницы не переписывать: те же
// value / onChange / disabled / className / style, варианты — обычными
// <option value>…</option> внутри. onChange получает объект с
// e.target.value (строка, как у нативного select).

const SEARCH_THRESHOLD = 12

// className вызывающего кода писался под нативный select (рамка, фон,
// скругление, отступы) — оставляем из него только размеры и раскладку.
const VISUAL_CLASS = /^(?:[a-z-]+:)*(?:rounded|bg-|border|shadow|px-|py-|p-|outline|ring|focus|text-(?:sm|xs|base)$)/

function layoutClasses(className) {
  return (className || '').split(/\s+/).filter(c => c && !VISUAL_CLASS.test(c)).join(' ')
}

function nodeText(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (React.isValidElement(node)) return nodeText(node.props.children)
  return ''
}

function collectOptions(children, out = []) {
  React.Children.forEach(children, child => {
    if (!React.isValidElement(child)) return
    if (child.type === 'option') {
      const { value, children: label, disabled } = child.props
      const text = nodeText(label)
      out.push({ value: String(value ?? text), label, text, disabled: !!disabled })
    } else if (child.type === React.Fragment || child.type === 'optgroup') {
      collectOptions(child.props.children, out)
    }
  })
  return out
}

export function Select({ value, onChange, children, className, style, disabled, placeholder = '—', title, id, 'aria-label': ariaLabel }) {
  const options = React.useMemo(() => collectOptions(children), [children])
  const current = String(value ?? '')
  const selected = options.find(o => o.value === current)

  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [active, setActiveState] = React.useState(-1)
  // индекс ещё и в ref: быстрые нажатия (стрелка + Enter подряд) не должны видеть устаревшее значение
  const activeRef = React.useRef(-1)
  const setActive = i => { activeRef.current = i; setActiveState(i) }
  const listRef = React.useRef(null)
  const searchRef = React.useRef(null)
  const typeahead = React.useRef({ text: '', at: 0 })

  const withSearch = options.length > SEARCH_THRESHOLD
  const q = query.trim().toLowerCase()
  const visible = q ? options.filter(o => o.text.toLowerCase().includes(q)) : options

  const choose = opt => {
    if (!opt || opt.disabled) return
    setOpen(false)
    if (opt.value !== current) onChange?.({ target: { value: opt.value }, currentTarget: { value: opt.value } })
  }

  const onOpenChange = next => {
    setOpen(next)
    if (next) {
      setQuery('')
      setActive(Math.max(0, options.findIndex(o => o.value === current)))
    }
  }

  // активный пункт всегда в зоне видимости
  React.useEffect(() => {
    if (!open || active < 0) return
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const move = step => {
    if (!visible.length) return
    let i = activeRef.current
    for (let n = 0; n < visible.length; n++) {
      i = (i + step + visible.length) % visible.length
      if (!visible[i].disabled) break
    }
    setActive(i)
  }

  const onListKeyDown = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0) }
    else if (e.key === 'End') { e.preventDefault(); setActive(visible.length - 1) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(visible[activeRef.current]) }
    else if (!withSearch && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // как у нативного select: набор первых букв прыгает к варианту
      const now = Date.now()
      const t = typeahead.current
      t.text = (now - t.at < 700 ? t.text : '') + e.key.toLowerCase()
      t.at = now
      const i = visible.findIndex(o => !o.disabled && o.text.toLowerCase().startsWith(t.text))
      if (i >= 0) setActive(i)
    }
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild disabled={disabled}>
        <button
          type="button"
          id={id}
          title={title ?? (selected ? selected.text : undefined)}
          aria-label={ariaLabel}
          role="combobox"
          aria-expanded={open}
          data-slot="select"
          style={style}
          className={cn(
            'inline-flex h-9 min-w-0 items-center justify-between gap-2 rounded-xl border border-input bg-surface px-3 text-left text-sm shadow-card outline-none transition-colors',
            'hover:bg-surface-2 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20',
            'disabled:pointer-events-none disabled:opacity-50 data-[state=open]:border-ring',
            layoutClasses(className),
          )}
        >
          <span className={cn('min-w-0 truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : placeholder}
          </span>
          <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-180')} />
        </button>
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          onKeyDown={onListKeyDown}
          onOpenAutoFocus={e => {
            e.preventDefault()
            ;(withSearch ? searchRef.current : listRef.current)?.focus()
          }}
          className={cn(
            'z-50 flex max-h-[min(20rem,var(--radix-popover-content-available-height))] min-w-[var(--radix-popover-trigger-width)] max-w-[min(28rem,calc(100vw-16px))] flex-col overflow-hidden',
            'rounded-2xl border border-line bg-popover text-popover-foreground shadow-float outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2',
          )}
        >
          {withSearch && (
            <div className="border-b border-line p-1.5">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={e => { setQuery(e.target.value); setActive(0) }}
                  placeholder="Поиск…"
                  className="h-8 w-full rounded-lg bg-surface-2 pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
            </div>
          )}
          <div ref={listRef} tabIndex={-1} role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1 outline-none">
            {visible.length === 0 && <div className="px-2.5 py-2 text-sm text-muted-foreground">Ничего не найдено</div>}
            {visible.map((o, i) => {
              const isSelected = o.value === current
              return (
                <div
                  key={o.value + '|' + i}
                  data-index={i}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={o.disabled}
                  onMouseMove={() => active !== i && setActive(i)}
                  onClick={() => choose(o)}
                  className={cn(
                    'flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
                    i === active && 'bg-surface-2',
                    isSelected && 'font-medium text-brand',
                    o.disabled && 'cursor-default opacity-40',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {isSelected && <Check className="size-4 shrink-0" />}
                </div>
              )
            })}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
