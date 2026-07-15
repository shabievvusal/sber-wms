import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

// Номера страниц с многоточием: 1 … c-1 c c+1 … N — вместо голого «назад/вперёд».
function getPageList(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages = new Set([1, total, current, current - 1, current + 1])
  const sorted = [...pages].filter(p => p >= 1 && p <= total).sort((a, b) => a - b)
  const withGaps = []
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) withGaps.push('gap')
    withGaps.push(sorted[i])
  }
  return withGaps
}

export function Pagination({ page, totalPages, onChange, className }) {
  if (totalPages <= 1) return null
  const pages = getPageList(page, totalPages)

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Button size="icon" variant="outline" disabled={page <= 1} onClick={() => onChange(page - 1)} title="Назад">
        <ChevronLeft className="size-4" />
      </Button>

      {pages.map((p, i) =>
        p === 'gap' ? (
          <span key={`gap-${i}`} className="flex size-8 items-center justify-center text-muted-foreground">
            <MoreHorizontal className="size-4" />
          </span>
        ) : (
          <Button
            key={p}
            size="icon"
            variant={p === page ? 'default' : 'outline'}
            onClick={() => onChange(p)}
          >
            {p}
          </Button>
        )
      )}

      <Button size="icon" variant="outline" disabled={page >= totalPages} onClick={() => onChange(page + 1)} title="Далее">
        <ChevronRight className="size-4" />
      </Button>
    </div>
  )
}
