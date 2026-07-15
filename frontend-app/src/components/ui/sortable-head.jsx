import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TableHead } from '@/components/ui/table'

/** Кликабельный заголовок колонки — стрелка показывает текущее направление сортировки. */
export function SortableHead({ label, sortKey, sort, onSort, className }) {
  const active = sort.key === sortKey
  const Icon = !active ? ArrowUpDown : sort.dir === 'desc' ? ArrowDown : ArrowUp
  return (
    <TableHead className={cn('cursor-pointer select-none', className)} onClick={() => onSort(sortKey)}>
      <span className="inline-flex items-center gap-1">
        {label}
        <Icon className={cn('size-3', !active && 'opacity-30')} />
      </span>
    </TableHead>
  )
}
