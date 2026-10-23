import { Package, ClipboardList, Hash, Scale, HardHat, Calendar } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fmtNum, fmtWeight, shiftLabel } from './format'

// Плитка показателя в стиле WMS (supervisor/common.tsx → Stat): цветной
// значок · подпись, под ними крупное значение. Акцентная плитка — с
// фирменным градиентом.
function Tile({ Icon, label, value, color = 'var(--brand)', accent, loading }) {
  return (
    <div className={cn(
      'rounded-3xl border p-4 shadow-card transition-transform duration-200 hover:-translate-y-0.5',
      accent ? 'bg-brand-gradient border-transparent text-white' : 'border-line bg-card',
    )}>
      <div className="flex items-center gap-2">
        <span
          className="grid size-7 shrink-0 place-items-center rounded-lg"
          style={accent ? { background: 'rgba(255,255,255,0.18)', color: '#fff' } : { background: `color-mix(in oklab, ${color} 14%, transparent)`, color }}
        >
          <Icon size={15} strokeWidth={2.2} />
        </span>
        <span className={cn('line-clamp-2 text-[13px] font-medium leading-tight', accent ? 'text-white/85' : 'text-ink-2')} title={label}>{label}</span>
      </div>
      {loading
        ? <div className={cn('mt-3 h-[32px] w-2/3 animate-pulse rounded-lg', accent ? 'bg-white/25' : 'bg-surface-2')} />
        : <div className="tabular mt-3 truncate text-[26px] font-semibold leading-tight tracking-tight">{value}</div>}
    </div>
  )
}

// 8 KPI-плиток — перенесено из оригинала (StatsCards.jsx), только для
// операции «Комплектация» (для остальных 3 операций скрыты, как и в оригинале).
export function StatsCards({ summary, shift, dateStr, loading }) {
  const hourly = summary?.hourly || []
  const storageOps = hourly.reduce((s, h) => s + (h.storageOps || 0), 0)

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 2xl:grid-cols-8">
      <Tile loading={loading} Icon={Package} label="Операций" value={fmtNum(summary?.totalOps)} color="#2a78d6" />
      <Tile loading={loading} Icon={ClipboardList} label="Задач (хранение)" value={fmtNum(storageOps)} color="#eb6834" />
      <Tile loading={loading} Icon={Hash} label="Единиц товара" value={fmtNum(summary?.totalQty)} accent />
      <Tile loading={loading} Icon={Scale} label="Вес (хранение)" value={fmtWeight(summary?.totalWeightStorageGrams)} color="#1baf7a" />
      <Tile loading={loading} Icon={Scale} label="Вес (КДК)" value={fmtWeight(summary?.totalWeightKdkGrams)} color="#2a78d6" />
      <Tile loading={loading} Icon={Scale} label="Вес итог" value={fmtWeight(summary?.totalWeightGrams)} color="#7c3aed" />
      <Tile loading={loading} Icon={HardHat} label="Сотрудников" value={fmtNum(summary?.executors?.length)} color="#eda100" />
      <Tile Icon={Calendar} label="Смена" value={<span className="block truncate text-sm font-semibold leading-snug" title={shiftLabel(dateStr, shift)}>{shiftLabel(dateStr, shift)}</span>} color="#e87ba4" />
    </div>
  )
}

// Плитки операции «Приёмка» — итоги смены по принятым поставкам.
export function ReceivingStatsCards({ summary, loading }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6">
      <Tile loading={loading} Icon={Package} label="Поставок" value={fmtNum(summary?.totalOps)} accent />
      <Tile loading={loading} Icon={ClipboardList} label="ЕО" value={fmtNum(summary?.totalSecondary)} color="#2a78d6" />
      <Tile loading={loading} Icon={Hash} label="SKU" value={fmtNum(summary?.totalSku)} color="#eb6834" />
      <Tile loading={loading} Icon={Hash} label="Штук" value={fmtNum(summary?.totalPieces)} color="#7c3aed" />
      <Tile loading={loading} Icon={Scale} label="Вес" value={fmtWeight(summary?.totalWeightGrams)} color="#1baf7a" />
      <Tile loading={loading} Icon={HardHat} label="Приёмщиков" value={fmtNum(summary?.executors?.length)} color="#eda100" />
    </div>
  )
}
