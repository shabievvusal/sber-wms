import * as React from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { cn } from '@/lib/utils'

const inputClass = cn(
  'flex h-9 w-full min-w-0 rounded-xl border border-input bg-surface px-3 py-1 text-sm shadow-card transition-[color,box-shadow,border-color] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
  'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
  'aria-invalid:ring-destructive/20 aria-invalid:border-destructive',
)

const Input = React.forwardRef(function Input({ className, type, list, ...props }, ref) {
  if (list) return <SuggestInput ref={ref} listId={list} className={className} type={type} {...props} />
  return <input ref={ref} type={type} data-slot="input" className={cn(inputClass, className)} {...props} />
})

// ─── Подсказки вместо нативного <datalist> ──────────────────────────────────
// Список подсказок браузера не стилизуется (системная рамка, нет тёмной темы),
// поэтому <Input list="id"> рисует свой. Источник вариантов прежний — элемент
// <datalist id> на странице (его <option value>подпись</option>), так что
// страницы менять не нужно.

const MAX_SHOWN = 50

function readOptions(listId) {
  const dl = typeof document !== 'undefined' ? document.getElementById(listId) : null
  if (!dl) return []
  return Array.from(dl.querySelectorAll('option')).map(o => {
    const value = o.value
    const text = (o.textContent || '').trim()
    return { value, label: text && text !== value ? text : '' }
  })
}

// Значение ставим через нативный сеттер + событие input — так срабатывает
// обычный onChange React у контролируемого поля.
function setNativeValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

const SuggestInput = React.forwardRef(function SuggestInput({ listId, className, onKeyDown, onFocus, onBlur, onChange, value, defaultValue, ...props }, ref) {
  const innerRef = React.useRef(null)
  const listRef = React.useRef(null)
  const [open, setOpen] = React.useState(false)
  const [active, setActiveState] = React.useState(-1)
  // индекс ещё и в ref: быстрые нажатия (стрелка + Enter подряд) не должны видеть устаревшее значение
  const activeRef = React.useRef(-1)
  const setActive = next => {
    const i = typeof next === 'function' ? next(activeRef.current) : next
    activeRef.current = i
    setActiveState(i)
  }
  const [typed, setTyped] = React.useState(false)

  const setRefs = el => {
    innerRef.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) ref.current = el
  }

  const current = String(value ?? innerRef.current?.value ?? defaultValue ?? '')
  const q = typed ? current.trim().toLowerCase() : ''
  const options = open ? readOptions(listId) : []
  const shown = options
    .filter(o => !q || o.value.toLowerCase().includes(q) || o.label.toLowerCase().includes(q))
    .filter(o => !(o.value === current && options.length > 1 && q))
    .slice(0, MAX_SHOWN)
  const visible = open && shown.length > 0

  React.useEffect(() => {
    if (!visible || active < 0) return
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [visible, active])

  const choose = opt => {
    if (!opt || !innerRef.current) return
    setNativeValue(innerRef.current, opt.value)
    setOpen(false)
    setActive(-1)
    setTyped(false)
  }

  const handleKeyDown = e => {
    if (visible) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => (i + 1) % shown.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => (i <= 0 ? shown.length - 1 : i - 1)); return }
      if (e.key === 'Enter' && activeRef.current >= 0) { e.preventDefault(); e.stopPropagation(); choose(shown[activeRef.current]); return }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); return }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault(); setOpen(true); setTyped(false); setActive(0); return
    }
    onKeyDown?.(e)
  }

  return (
    <PopoverPrimitive.Root open={visible} onOpenChange={o => { if (!o) setOpen(false) }}>
      <PopoverPrimitive.Anchor asChild>
        <input
          ref={setRefs}
          data-slot="input"
          autoComplete="off"
          role="combobox"
          aria-expanded={visible}
          aria-autocomplete="list"
          className={cn(inputClass, className)}
          value={value}
          defaultValue={defaultValue}
          onChange={e => { setTyped(true); setOpen(true); setActive(-1); onChange?.(e) }}
          onFocus={e => { setOpen(true); setTyped(false); onFocus?.(e) }}
          onClick={() => { if (!open) { setOpen(true); setTyped(false) } }}
          onBlur={e => { setOpen(false); onBlur?.(e) }}
          onKeyDown={handleKeyDown}
          {...props}
        />
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={e => e.preventDefault()}
          onCloseAutoFocus={e => e.preventDefault()}
          onInteractOutside={e => { if (e.target === innerRef.current) e.preventDefault() }}
          className={cn(
            'z-50 max-h-[min(18rem,var(--radix-popover-content-available-height))] min-w-[var(--radix-popover-trigger-width)] max-w-[min(28rem,calc(100vw-16px))] overflow-hidden',
            'rounded-2xl border border-line bg-popover text-popover-foreground shadow-float outline-none',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          )}
        >
          <div ref={listRef} role="listbox" className="max-h-[inherit] overflow-y-auto p-1">
            {shown.map((o, i) => (
              <div
                key={o.value + '|' + i}
                data-index={i}
                role="option"
                aria-selected={i === active}
                // mousedown, а не click: иначе поле теряет фокус и список закрывается раньше выбора
                onMouseDown={e => { e.preventDefault(); choose(o) }}
                onMouseMove={() => active !== i && setActive(i)}
                className={cn(
                  'flex cursor-pointer select-none items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
                  i === active && 'bg-surface-2',
                  o.value === current && 'font-medium text-brand',
                )}
              >
                <span className="min-w-0 truncate">{o.value}</span>
                {o.label && <span className="ml-auto min-w-0 truncate pl-2 text-xs text-muted-foreground">{o.label}</span>}
              </div>
            ))}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
})

export { Input }
