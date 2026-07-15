import { Badge } from '@/components/ui/badge'
import { STATUS_LABELS, STATUS_VARIANT, PICK_STATUS_LABELS, PICK_STATUS_VARIANT } from './constants'

export function StatusBadge({ status }) {
  return <Badge variant={STATUS_VARIANT[status] || 'outline'}>{STATUS_LABELS[status] || status || '—'}</Badge>
}

export function PickStatusBadge({ status, pct }) {
  if (!status) return <span className="text-muted-foreground">—</span>
  return (
    <Badge variant={PICK_STATUS_VARIANT[status] || 'outline'}>
      {PICK_STATUS_LABELS[status] || status}{status === 'in_progress' && pct != null ? ` ${pct}%` : ''}
    </Badge>
  )
}
