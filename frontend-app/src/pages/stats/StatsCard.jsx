// Обёртка секции — тонкая шапка с границей снизу (плотнее, чем вертикальный
// заголовок shadcn Card), оформление — как карточки WMS.
export function StatsCard({ title, headerExtra, children }) {
  return (
    <div className="overflow-hidden rounded-3xl border border-line bg-card shadow-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
        <h2 className="shrink-0 text-[15px] font-semibold tracking-tight">{title}</h2>
        {headerExtra}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}
