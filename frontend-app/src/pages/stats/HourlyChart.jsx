import { fmtNum, hourRangeLabel } from './format'

// Перенесено из оригинала (HourlyChart.jsx) — тот же приём (самодельные
// CSS-бары, без графической библиотеки — см. PLAN.md/skill dataviz) и та же
// плотность (подписи количества/людей над каждым часом, колонки 52–80px,
// бары 120px высотой). Исправлена только кодировка цвета: оригинал красил
// «Хранение»/«КДК» двумя оттенками ОДНОГО зелёного (читается как порядковая
// шкала, а не две независимые категории) — здесь фирменный зелёный
// (Хранение) + отдельный категориальный синий (КДК), оба прошли
// validate_palette.js на light/dark (см. PLAN.md).
export function HourlyChart({ hourly }) {
  const maxBar = Math.max(1, ...hourly.map(h => Math.max(h.storageOps || 0, h.kdkOps || 0)))

  return (
    <div className="space-y-1">
      <div className="flex items-end gap-1 overflow-x-auto pt-3">
        {hourly.map(h => {
          const storagePct = Math.max(2.5, ((h.storageOps || 0) / maxBar) * 100)
          const kdkPct = Math.max(2.5, ((h.kdkOps || 0) / maxBar) * 100)
          const totalOps = (h.storageOps || 0) + (h.kdkOps || 0)
          const totalEmployees = (h.storageEmployees || 0) + (h.kdkEmployees || 0)
          return (
            <div key={h.hour} className="flex min-w-[52px] max-w-20 flex-1 flex-col items-center">
              <div className="mb-1.5 flex min-h-[32px] flex-col items-center justify-end gap-px">
                <span className="text-[11px] font-bold leading-tight">{fmtNum(totalOps)}</span>
                <span className="text-[10px] leading-tight text-muted-foreground">{totalEmployees} чел.</span>
              </div>
              <div className="flex h-[120px] w-full items-end gap-0.5">
                <div
                  className="flex-1 rounded-t bg-success transition-colors hover:bg-success/80"
                  style={{ height: `${storagePct}%` }}
                  title={`Хранение: ${fmtNum(h.storageOps)} · ${fmtNum(h.storageEmployees)} чел.`}
                />
                <div
                  className="flex-1 rounded-t bg-[#2563EB] transition-colors hover:bg-[#1d4fd1] dark:bg-[#3B82F6] dark:hover:bg-[#2563EB]"
                  style={{ height: `${kdkPct}%` }}
                  title={`КДК: ${fmtNum(h.kdkOps)} · ${fmtNum(h.kdkEmployees)} чел.`}
                />
              </div>
              <div className="mt-1 w-full border-t pt-1 text-center" title={hourRangeLabel(h.hour)}>
                <span className="text-[11px] text-muted-foreground">{String(h.hour).padStart(2, '0')}:00</span>
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-3.5 pt-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-sm bg-success" /> Хранение</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-sm bg-[#2563EB] dark:bg-[#3B82F6]" /> КДК</span>
      </div>
    </div>
  )
}
