import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { calcForecastPH, calcForecastTasks, fmt, fmtTime } from './format'

export function ProgressBar({ done, total }) {
  const pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0
  return (
    <div className="relative h-5 overflow-hidden rounded-full bg-muted">
      <div className="h-full bg-primary transition-all" style={{ width: pct + '%' }} />
      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-medium">{pct}%</span>
    </div>
  )
}

export function StatRow({ label, value, bold }) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={bold ? 'font-semibold' : ''}>{value}</span>
    </div>
  )
}

const STATUS_VARIANT = { ok: 'success', warn: 'warning', over: 'destructive' }
const STATUS_ICON = { ok: '✓', warn: '⚠', over: '✕' }

export function ForecastBadge({ forecast, shiftEndTime }) {
  if (!forecast) return null
  const { status, projFinish, minDiff } = forecast
  const hint = status === 'ok'
    ? `Запас ${Math.abs(minDiff)} мин до ${shiftEndTime}`
    : status === 'warn'
      ? `Буфер ${minDiff} мин до ${shiftEndTime}`
      : `Опоздание ~${Math.abs(minDiff)} мин`
  return (
    <div className="space-y-1 rounded-md border p-2">
      <div className="flex items-center gap-2">
        <Badge variant={STATUS_VARIANT[status]}>{STATUS_ICON[status]} {fmtTime(projFinish)}</Badge>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
    </div>
  )
}

const ZONE_BORDER = { ok: 'border-l-success', warn: 'border-l-warning', over: 'border-l-destructive' }

export function ZoneCard({ zoneKey, label, rest, restUnit, personHours, people, speed, shiftEnd, shiftEndTime, loading, onPeople, onSpeed, speedPlaceholder }) {
  const forecast = personHours != null
    ? calcForecastPH(personHours, people, shiftEnd)
    : (rest != null && speed)
      ? calcForecastTasks(rest, people, speed, shiftEnd)
      : null

  const borderCls = forecast ? ZONE_BORDER[forecast.status] : 'border-l-transparent'

  return (
    <div className={`space-y-2.5 rounded-lg border border-l-4 bg-card p-4 ${borderCls}`}>
      <div className="flex items-center gap-2">
        <span className="font-semibold">{zoneKey}</span>
        {people > 0 && <Badge variant="secondary">{people} чел.</Badge>}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>

      {rest != null && <StatRow label="Остаток" value={`${fmt(Math.round(rest))} ${restUnit ?? 'СЗ'}`} bold />}
      {personHours != null && personHours > 0 && <StatRow label="Часов работы" value={personHours.toFixed(1)} />}

      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Людей</span>
          <Input type="number" min="1" className="h-8" placeholder="—" value={people || ''} onChange={e => onPeople(e.target.value)} />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">СЗ/ч</span>
          <Input type="number" min="1" className="h-8" placeholder={speedPlaceholder ?? '—'} value={speed || ''} onChange={e => onSpeed(e.target.value)} />
        </label>
      </div>

      {!loading && <ForecastBadge forecast={forecast} shiftEndTime={shiftEndTime} />}
      {!loading && !forecast && people > 0 && rest == null && personHours == null && (
        <div className="text-xs text-muted-foreground">Нет данных об остатке</div>
      )}
      {!loading && !people && (
        <div className="text-xs text-muted-foreground">Укажите кол-во людей</div>
      )}
    </div>
  )
}
