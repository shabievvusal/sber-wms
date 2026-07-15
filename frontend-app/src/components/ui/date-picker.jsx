import * as React from 'react'
import { format } from 'date-fns'
import { ru } from 'date-fns/locale'
import { CalendarIcon, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

// ── date <-> "YYYY-MM-DD" ────────────────────────────────────────────────────
// Тот же формат строки, что и раньше использовал нативный <input type="date">
// и старый DatePicker.jsx — остальной код страниц не пришлось переписывать.

function parseISO(str) {
  if (!str) return undefined
  const [y, m, d] = String(str).slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return undefined
  return new Date(y, m - 1, d)
}

function toISO(date) {
  if (!date) return ''
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Единый DatePicker проекта — Popover + Calendar вместо нативного <input type="date">.
 * Интерфейс совместим с value/onChange от input, чтобы использовать как раньше:
 *   <DatePicker value={dateStr} onChange={e => setDateStr(e.target.value)} />
 */
function DatePicker({ value, onChange, placeholder = 'Выберите дату', className, min, max, disabled }) {
  const [open, setOpen] = React.useState(false)
  const selected = parseISO(value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn('justify-start gap-2 font-normal', !selected && 'text-muted-foreground', className)}
        >
          <CalendarIcon className="size-4 shrink-0 opacity-70" />
          {selected ? format(selected, 'd MMM yyyy', { locale: ru }) : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          onSelect={date => { onChange?.({ target: { value: toISO(date) } }); setOpen(false) }}
          disabled={date => (min && toISO(date) < min) || (max && toISO(date) > max)}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * Период (from/to) как ОДИН контрол с одним триггером — вместо двух отдельных
 * полей + ручной кнопки сброса. onChange отдаёт { from, to } строками "YYYY-MM-DD".
 */
function DateRangePicker({ from, to, onChange, placeholder = 'Выберите период', className }) {
  const [open, setOpen] = React.useState(false)
  const range = { from: parseISO(from), to: parseISO(to) }
  const hasValue = !!range.from

  const label = !range.from
    ? placeholder
    : !range.to || range.to.getTime() === range.from.getTime()
      ? format(range.from, 'd MMM yyyy', { locale: ru })
      : `${format(range.from, 'd MMM', { locale: ru })} – ${format(range.to, 'd MMM yyyy', { locale: ru })}`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn('justify-start gap-2 font-normal', !hasValue && 'text-muted-foreground', className)}
        >
          <CalendarIcon className="size-4 shrink-0 opacity-70" />
          <span className="truncate">{label}</span>
          {hasValue && (
            <span
              role="button"
              tabIndex={-1}
              className="ml-auto rounded-sm p-0.5 opacity-60 hover:opacity-100 hover:bg-muted"
              onClick={e => { e.stopPropagation(); onChange?.({ from: '', to: '' }) }}
            >
              <X className="size-3.5" />
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="range"
          numberOfMonths={2}
          selected={range}
          defaultMonth={range.from}
          onSelect={r => onChange?.({ from: toISO(r?.from), to: toISO(r?.to) })}
        />
        <div className="flex items-center justify-between gap-2 border-t p-3">
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange?.({ from: '', to: '' })}>
            Сбросить
          </Button>
          <Button type="button" size="sm" onClick={() => setOpen(false)}>Готово</Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export { DatePicker, DateRangePicker }
