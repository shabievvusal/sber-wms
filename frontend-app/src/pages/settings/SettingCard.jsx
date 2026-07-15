import { cn } from '@/lib/utils'

/**
 * Общая обёртка карточки настроек — иконка + заголовок + подзаголовок (+
 * произвольные кнопки справа), тело карточки — `children`. Повторяющийся
 * паттерн почти во всех карточках оригинала (UsersCard, RolesCard,
 * AutoFetchCard, TsdSettingsCard, ProductWeightsCard, MyModulesCard, ...).
 */
export function SettingCard({ icon: Icon, title, subtitle, actions, accent, children, className }) {
  return (
    <div className={cn('rounded-lg border bg-card', accent && 'border-l-4 border-l-warning', className)}>
      <div className="flex flex-wrap items-center gap-3 border-b p-4">
        {Icon && (
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
            <Icon className="size-5" strokeWidth={1.5} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="font-semibold leading-tight">{title}</div>
          {subtitle && <div className="text-sm text-muted-foreground">{subtitle}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

/** Строка «подпись слева / контрол справа» внутри SettingCard — тоже сквозной паттерн. */
export function SettingRow({ label, desc, children }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {desc && <div className="text-sm text-muted-foreground">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
