import { Package, ClipboardList, Hash, Scale, HardHat, Calendar } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fmtNum, fmtWeight } from './format'

function Tile({ Icon, label, value, accent }) {
  return (
    <div className={cn(
      'rounded-lg border bg-card p-5 text-center shadow-sm transition-shadow hover:shadow-md',
      accent && 'border-success bg-success text-success-foreground',
    )}>
      <Icon className={cn('mx-auto mb-1 size-5', accent ? 'text-success-foreground' : 'text-muted-foreground')} strokeWidth={1.75} />
      <div className="text-[28px] font-bold leading-tight">{value}</div>
      <div className={cn('text-xs', accent ? 'text-success-foreground/75' : 'text-muted-foreground')}>{label}</div>
    </div>
  )
}

// 8 KPI-плиток — перенесено из оригинала (StatsCards.jsx), только для
// операции «Комплектация» (для остальных 3 операций скрыты, как и в оригинале).
// Плотность/размеры (28px значение, 20px паддинг, залитая зелёным акцентная
// плитка, иконка над значением) — как в оригинале, а не уменьшенный вариант.
export function StatsCards({ summary, shiftLabel, dateStr }) {
  const hourly = summary?.hourly || []
  const storageOps = hourly.reduce((s, h) => s + (h.storageOps || 0), 0)

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-8">
      <Tile Icon={Package} label="Операций" value={fmtNum(summary?.totalOps)} />
      <Tile Icon={ClipboardList} label="Задач (хранение)" value={fmtNum(storageOps)} />
      <Tile Icon={Hash} label="Единиц товара" value={fmtNum(summary?.totalQty)} accent />
      <Tile Icon={Scale} label="Вес (хранение)" value={fmtWeight(summary?.totalWeightStorageGrams)} />
      <Tile Icon={Scale} label="Вес (КДК)" value={fmtWeight(summary?.totalWeightKdkGrams)} />
      <Tile Icon={Scale} label="Вес итог" value={fmtWeight(summary?.totalWeightGrams)} />
      <Tile Icon={HardHat} label="Сотрудников" value={fmtNum(summary?.executors?.length)} />
      <Tile Icon={Calendar} label="Дата" value={<span className="text-base font-semibold">{dateStr}<br />{shiftLabel}</span>} />
    </div>
  )
}
