import { TaskTypeBadge } from './TaskTypeBadge'

const TYPES = ['КДК', 'ХР', 'Паллет']

/** Сводная строка вверху страницы — сколько человек в работе прямо сейчас, по
 * типу задачи и по компаниям. Пусто (null), если сейчас никто не активен —
 * ровно как в оригинале. */
export function OperationSummary({ rows }) {
  const totalByType = { 'КДК': 0, 'ХР': 0, 'Паллет': 0 }
  const byCompany = new Map()

  for (const r of rows) {
    if (!r.isActive || !r.taskType) continue
    totalByType[r.taskType] = (totalByType[r.taskType] || 0) + 1
    if (!byCompany.has(r.company)) byCompany.set(r.company, { 'КДК': 0, 'ХР': 0, 'Паллет': 0 })
    const ct = byCompany.get(r.company)
    ct[r.taskType] = (ct[r.taskType] || 0) + 1
  }

  const totalActive = TYPES.reduce((sum, t) => sum + totalByType[t], 0)
  if (totalActive === 0) return null

  const companyRows = [...byCompany.entries()]
    .filter(([, ct]) => TYPES.some(t => ct[t] > 0))
    .sort((a, b) => TYPES.reduce((s, t) => s + b[1][t] - a[1][t], 0))

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm">В работе: <b className="text-base">{totalActive}</b></span>
        <div className="flex flex-wrap gap-1.5">
          {TYPES.map(t => totalByType[t] > 0 && (
            <span key={t} className="inline-flex items-center gap-1 text-xs">
              <TaskTypeBadge type={t} /> <b>{totalByType[t]}</b>
            </span>
          ))}
        </div>
      </div>
      <div className="space-y-1.5 border-t pt-3">
        {companyRows.map(([company, ct]) => {
          const sum = TYPES.reduce((s, t) => s + ct[t], 0)
          return (
            <div key={company} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-40 font-medium">{company}</span>
              <span className="text-muted-foreground">{sum}</span>
              <div className="flex flex-wrap gap-1.5">
                {TYPES.map(t => ct[t] > 0 && (
                  <span key={t} className="inline-flex items-center gap-1 text-xs">
                    <TaskTypeBadge type={t} /> <b>{ct[t]}</b>
                  </span>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
