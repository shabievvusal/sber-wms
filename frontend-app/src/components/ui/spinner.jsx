import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Центрированный спиннер для самой первой загрузки данных (когда показывать ещё нечего). */
export function Spinner({ label = 'Загрузка...', className }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 p-10 text-sm text-muted-foreground', className)}>
      <Loader2 className="size-6 animate-spin text-primary" />
      {label}
    </div>
  )
}
