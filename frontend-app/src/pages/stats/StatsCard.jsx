// Обёртка секции — как «.card»/«.cardHeader» оригинала: тонкая шапка с
// границей снизу (не просторный вертикальный заголовок shadcn Card), чтобы
// плотность страницы совпадала с оригиналом.
export function StatsCard({ title, headerExtra, children }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-3 border-b px-5 py-3">
        <h2 className="shrink-0 text-[13px] font-semibold">{title}</h2>
        {headerExtra}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}
