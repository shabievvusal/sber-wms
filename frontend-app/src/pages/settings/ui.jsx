import { cn } from '@/lib/utils'
import { VS_MODULE_LABELS } from './constants'

// Общие мелкие элементы карточек Настроек — чтобы таблицы и списки во всех
// вкладках выглядели одинаково (как список сотрудников).

/** Шапка таблицы — тот же вид, что у списка сотрудников. */
export const theadCls = 'bg-surface-2/60'
export const thCls = 'px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground'
export const trCls = 'group border-b border-line last:border-0 transition-colors hover:bg-surface-2/40'
export const tableWrapCls = 'overflow-x-auto rounded-2xl border border-line'

const TONES = {
  default: 'hover:bg-surface-2 hover:text-foreground',
  danger: 'hover:bg-destructive/10 hover:text-destructive',
  success: 'hover:bg-success/10 hover:text-success',
  brand: 'hover:bg-brand-soft hover:text-brand',
}

/** Кнопка-иконка действия в строке (изменить / удалить / одобрить…). */
export function IconAction({ icon: Icon, title, onClick, tone = 'default', disabled, className }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors disabled:pointer-events-none disabled:opacity-40',
        TONES[tone],
        className,
      )}
    >
      <Icon className="size-4" />
    </button>
  )
}

export const initials = name => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase()

export function Avatar({ name, className }) {
  return (
    <span className={cn('grid size-8 shrink-0 place-items-center rounded-xl bg-brand-soft text-xs font-semibold text-brand', className)}>
      {initials(name)}
    </span>
  )
}

/** Модули роли/пользователя: первые несколько чипами, остальные — «+N». */
export function ModuleChips({ modules, max = 3, labels = VS_MODULE_LABELS }) {
  if (!modules?.length) return <span className="text-xs text-muted-foreground">нет разделов</span>
  const shown = modules.slice(0, max)
  const rest = modules.length - shown.length
  const all = modules.map(m => labels[m] || m).join(', ')
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1" title={all}>
      {shown.map(m => (
        <span key={m} className="truncate rounded-md bg-surface-2 px-1.5 py-0.5 text-xs text-ink-2">{labels[m] || m}</span>
      ))}
      {rest > 0 && <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-xs font-medium text-brand">+{rest}</span>}
    </span>
  )
}

/** Подпись над полем формы. */
export function Field({ label, hint, children, className }) {
  return (
    <label className={cn('block space-y-1.5', className)}>
      <span className="block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

/** Пустое состояние внутри карточки. */
export function Empty({ children }) {
  return <div className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-muted-foreground">{children}</div>
}
