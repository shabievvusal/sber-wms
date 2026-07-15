import { Badge } from '@/components/ui/badge'
import { TASK_TYPE_VARIANT } from './constants'

export function TaskTypeBadge({ type }) {
  if (!type) return <span className="text-muted-foreground">—</span>
  return <Badge variant={TASK_TYPE_VARIANT[type] || 'secondary'}>{type}</Badge>
}
