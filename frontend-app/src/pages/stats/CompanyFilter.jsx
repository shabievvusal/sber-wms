import { cn } from '@/lib/utils'

// Перенесено из оригинала (CompanyFilter.jsx) — чипы компаний, общий фильтр
// для всех таблиц ниже на странице.
export function CompanyFilter({ companies, value, onChange }) {
  const chips = [{ value: '__all__', label: 'Все сотрудники' }, ...companies.map(c => ({ value: c, label: c })), { value: '__none__', label: 'Не в списке' }]
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map(c => (
        <button
          key={c.value}
          type="button"
          onClick={() => onChange(c.value)}
          className={cn(
            'rounded-full border px-3.5 py-[5px] text-xs transition-colors',
            value === c.value ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:border-primary hover:text-primary',
          )}
        >
          {c.label}
        </button>
      ))}
    </div>
  )
}
