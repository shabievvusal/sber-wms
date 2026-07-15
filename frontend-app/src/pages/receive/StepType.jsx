import { Truck, PackageOpen, ClipboardList } from 'lucide-react'

const TYPES = [
  { key: 'ship', Icon: Truck, label: 'Отгрузка', desc: 'Маршрут уходит со склада' },
  { key: 'receive', Icon: PackageOpen, label: 'Приёмка', desc: 'Возврат РК с маршрута' },
  { key: 'eo_list', Icon: ClipboardList, label: 'Список ЕО', desc: 'ЕО по ЦФЗ в маршруте' },
]

export function StepType({ onSelect }) {
  return (
    <div className="grid grid-cols-1 gap-3">
      {TYPES.map(({ key, Icon, label, desc }) => (
        <button
          key={key}
          className="flex items-center gap-4 rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary hover:bg-accent"
          onClick={() => onSelect(key)}
        >
          <div className="flex size-12 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
            <Icon className="size-6" strokeWidth={1.5} />
          </div>
          <div>
            <div className="font-semibold">{label}</div>
            <div className="text-sm text-muted-foreground">{desc}</div>
          </div>
        </button>
      ))}
    </div>
  )
}
