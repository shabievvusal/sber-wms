import * as React from 'react'
import { format } from 'date-fns'
import { ru } from 'date-fns/locale'
import { CalendarIcon, ChevronLeft, ChevronRight, Clock, Moon, Sun, X } from 'lucide-react'

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
function DateRangePicker({ from, to, onChange, placeholder = 'Выберите период', className, disabled }) {
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
          disabled={disabled}
          className={cn('justify-start gap-2 font-normal', !hasValue && 'text-muted-foreground', className)}
        >
          <CalendarIcon className="size-4 shrink-0 opacity-70" />
          <span className="truncate">{label}</span>
          {hasValue && !disabled && (
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

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'))
const nextDayISO = iso => { const d = parseISO(iso); if (!d) return ''; d.setDate(d.getDate() + 1); return toISO(d) }

/**
 * Время «ЧЧ:ММ» — кнопка с часами, в попапе сетка часов и минут (шаг 5 мин)
 * вместо нативного <input type="time">, который в каждом браузере выглядит по-своему.
 */
function TimeSelect({ value, onChange, label }) {
  const [open, setOpen] = React.useState(false)
  const [h, m] = (value || '00:00').split(':')
  const chip = active => cn('h-7 rounded-md text-xs tabular-nums transition-colors', active ? 'bg-primary font-semibold text-primary-foreground' : 'hover:bg-muted')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="flex h-9 items-center gap-2 rounded-lg border border-input bg-card px-3 text-sm hover:bg-muted">
          <Clock className="size-3.5 opacity-60" />
          <span className="text-muted-foreground">{label}</span>
          <span className="font-semibold tabular-nums">{value || '—'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start">
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Часы</div>
        <div className="grid grid-cols-8 gap-1">
          {HOURS.map(x => <button key={x} type="button" className={chip(x === h)} onClick={() => onChange(`${x}:${m}`)}>{x}</button>)}
        </div>
        <div className="mb-1 mt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Минуты</div>
        <div className="grid grid-cols-6 gap-1">
          {MINUTES.map(x => <button key={x} type="button" className={chip(x === m)} onClick={() => { onChange(`${h}:${x}`); setOpen(false) }}>{x}</button>)}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Период с датой и временем — тот же компактный триггер, что у
 * DateRangePicker, но в попапе ещё время начала и конца. from/to — строки
 * "YYYY-MM-DDTHH:mm" (как у <input type="datetime-local">). Пока попап
 * открыт, правится черновик — onChange вызывается один раз, по «Готово».
 */
function DateTimeRangePicker({ from, to, onChange, placeholder = 'Выберите период', className, disabled, defaultFromTime = '09:00', defaultToTime = '21:00' }) {
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState({ from: '', to: '', fromTime: defaultFromTime, toTime: defaultToTime })

  React.useEffect(() => {
    if (!open) return
    setDraft({
      from: (from || '').slice(0, 10),
      to: (to || from || '').slice(0, 10),
      fromTime: (from || '').slice(11, 16) || defaultFromTime,
      toTime: (to || '').slice(11, 16) || defaultToTime,
    })
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const fromDate = parseISO(from)
  const toDate = parseISO(to)
  const hasValue = !!fromDate
  const fromTimeLabel = (from || '').slice(11, 16)
  const toTimeLabel = (to || '').slice(11, 16)
  const label = !hasValue
    ? placeholder
    : toDate && toISO(toDate) !== toISO(fromDate)
      ? `${format(fromDate, 'd MMM', { locale: ru })} ${fromTimeLabel} – ${format(toDate, 'd MMM', { locale: ru })} ${toTimeLabel}`
      : `${format(fromDate, 'd MMM', { locale: ru })}, ${fromTimeLabel}–${toTimeLabel}`

  const range = { from: parseISO(draft.from), to: parseISO(draft.to) }
  const canApply = !!draft.from && !!draft.fromTime && !!draft.toTime
  const apply = () => {
    const toDay = draft.to || draft.from
    onChange?.({ from: `${draft.from}T${draft.fromTime}`, to: `${toDay}T${draft.toTime}` })
    setOpen(false)
  }
  // быстрый выбор смены: день — 09:00–21:00 той же даты, ночь — 21:00 → 09:00 следующей
  const preset = kind => setDraft(d => {
    const day = d.from || toISO(new Date())
    return kind === 'day'
      ? { from: day, to: day, fromTime: '09:00', toTime: '21:00' }
      : { from: day, to: nextDayISO(day), fromTime: '21:00', toTime: '09:00' }
  })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn('justify-start gap-2 font-normal', !hasValue && 'text-muted-foreground', className)}
        >
          <CalendarIcon className="size-4 shrink-0 opacity-70" />
          <span className="truncate">{label}</span>
          {hasValue && !disabled && (
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
          onSelect={r => setDraft(d => ({ ...d, from: toISO(r?.from), to: toISO(r?.to) }))}
        />
        <div className="flex flex-wrap items-center gap-2 border-t px-3 pt-3 text-sm">
          <TimeSelect label="с" value={draft.fromTime} onChange={v => setDraft(d => ({ ...d, fromTime: v }))} />
          <TimeSelect label="по" value={draft.toTime} onChange={v => setDraft(d => ({ ...d, toTime: v }))} />
          <div className="ml-auto flex gap-1">
            <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => preset('day')}><Sun className="size-3.5" /> Дневная смена</Button>
            <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => preset('night')}><Moon className="size-3.5" /> Ночная смена</Button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 p-3">
          <Button type="button" variant="ghost" size="sm" onClick={() => { onChange?.({ from: '', to: '' }); setOpen(false) }}>
            Сбросить
          </Button>
          <Button type="button" size="sm" disabled={!canApply} onClick={apply}>Готово</Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

const MONTH_SHORT = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек']
const MONTH_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']

/**
 * Компактный выбор месяца — одна кнопка-триггер («Июль 2026») + попап с
 * навигацией по годам и сеткой 3×4 месяцев, вместо нативного <input
 * type="month"> (разный вид в разных браузерах/ОС) или двух отдельных
 * select'ов месяц/год. value/onChange — строка "YYYY-MM".
 */
function MonthPicker({ value, onChange, placeholder = 'Выберите месяц', className }) {
  const [open, setOpen] = React.useState(false)
  const [y, m] = value ? value.split('-').map(Number) : []
  const now = new Date()
  const [viewYear, setViewYear] = React.useState(y || now.getFullYear())

  React.useEffect(() => { if (open) setViewYear(y || now.getFullYear()) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const label = y && m ? `${MONTH_FULL[m - 1]} ${y}` : placeholder

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className={cn('justify-start gap-2 font-normal', !value && 'text-muted-foreground', className)}>
          <CalendarIcon className="size-4 shrink-0 opacity-70" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="start">
        <div className="mb-2 flex items-center justify-between">
          <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => setViewYear(v => v - 1)}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-sm font-medium">{viewYear}</span>
          <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => setViewYear(v => v + 1)}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-1">
          {MONTH_SHORT.map((name, i) => {
            const mNum = i + 1
            const active = viewYear === y && mNum === m
            return (
              <button
                key={name}
                type="button"
                className={cn(
                  'rounded-md px-2 py-1.5 text-sm hover:bg-accent',
                  active && 'bg-primary text-primary-foreground hover:bg-primary',
                )}
                onClick={() => { onChange?.(`${viewYear}-${String(mNum).padStart(2, '0')}`); setOpen(false) }}
              >
                {name}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export { DatePicker, DateRangePicker, DateTimeRangePicker, MonthPicker }
