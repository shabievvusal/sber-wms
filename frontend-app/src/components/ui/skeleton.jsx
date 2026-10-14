import { cn } from '@/lib/utils'

function Skeleton({ className, ...props }) {
  return <div data-slot="skeleton" className={cn('animate-pulse rounded-lg bg-surface-2', className)} {...props} />
}

export { Skeleton }
