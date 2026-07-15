import { parseIdleIntervalsForTimeline, parseIdleTotalMinutes } from './format'

// Перенесено из оригинала (HourlyEmployeeTable.jsx, встроенный виджет) —
// горизонтальная шкала простоев за смену (12ч = 720 мин), с подписью минут
// внутри блока, если он достаточно широкий (оригинал: `width >= 3`).
export function IdleTimeline({ intervals, shift, workedMinutes }) {
  const blocks = parseIdleIntervalsForTimeline(intervals, shift)
  const totalMin = parseIdleTotalMinutes(intervals)
  const workedMin = workedMinutes != null ? workedMinutes : Math.max(0, 12 * 60 - totalMin)

  return (
    <div className="w-56 space-y-1.5">
      <div className="relative h-[18px] overflow-hidden rounded-full bg-muted">
        {blocks.map((b, i) => (
          <div
            key={i}
            className="absolute inset-y-0.5 flex items-center justify-center overflow-hidden rounded-sm bg-destructive/80"
            style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%` }}
            title={`${b.minutes} мин`}
          >
            {b.widthPct >= 3 && <span className="text-[10px] font-semibold leading-none text-white">{b.minutes} м</span>}
          </div>
        ))}
      </div>
      {totalMin > 0 && (
        <div className="text-[11px] text-muted-foreground">
          Простои: {Math.floor(totalMin / 60)}ч {totalMin % 60}м · Отработано: {workedMin != null ? `${Math.floor(workedMin / 60)}ч ${workedMin % 60}м` : '—'}
        </div>
      )}
    </div>
  )
}
