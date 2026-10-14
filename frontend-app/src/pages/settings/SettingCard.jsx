import { cn } from '@/lib/utils'

/**
 * Общая обёртка карточки настроек — иконка + заголовок + подзаголовок (+
 * произвольные кнопки справа), тело карточки — `children`. Повторяющийся
 * паттерн почти во всех карточках оригинала (UsersCard, RolesCard,
 * AutoFetchCard, TsdSettingsCard, ProductWeightsCard, MyModulesCard, ...).
 * `accent` — карточка, требующая внимания (заявки и т.п.): жёлтый значок.
 * `danger` — опасные действия: красный значок и рамка.
 */
export function SettingCard({ icon: Icon, title, subtitle, actions, accent, danger, children, className, bodyClassName }) {
  return (
    <div className={cn('rounded-3xl border border-line bg-card shadow-card', danger && 'border-destructive/25', className)}>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
        {Icon && (
          <div className={cn(
            'grid size-10 shrink-0 place-items-center rounded-xl',
            danger ? 'bg-destructive/10 text-destructive' : accent ? 'bg-warning/15 text-warning' : 'bg-brand-soft text-brand',
          )}>
            <Icon className="size-5" strokeWidth={1.8} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold leading-tight tracking-tight">{title}</div>
          {subtitle && <div className="mt-0.5 text-sm text-muted-foreground">{subtitle}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className={cn('p-5', bodyClassName)}>{children}</div>
    </div>
  )
}

/** Строка «подпись слева / контрол справа» внутри SettingCard — тоже сквозной паттерн. */
export function SettingRow({ label, desc, children }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-line py-4 first:pt-0 last:border-0 last:pb-0">
      <div className="min-w-0 flex-1 basis-64">
        <div className="text-sm font-medium">{label}</div>
        {desc && <div className="mt-0.5 text-sm text-muted-foreground">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
