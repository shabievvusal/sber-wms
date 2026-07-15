import { Checkbox } from '@/components/ui/checkbox'

/**
 * Группа чекбоксов «модули» / «действия» — повторяется в VsUserEditModal,
 * RolesCard (добавление/редактирование), MyModulesCard оригинала. Один
 * компонент вместо трёх копий одной и той же разметки.
 */
export function ModulesCheckboxGroup({ items, labels, selected, onToggle, columns = true }) {
  return (
    <div className={columns ? 'grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3' : 'flex flex-wrap gap-x-4 gap-y-2'}>
      {items.map(key => (
        <label key={key} className="flex items-center gap-2 text-sm font-normal">
          <Checkbox checked={selected.has(key)} onCheckedChange={() => onToggle(key)} />
          {labels[key] || key}
        </label>
      ))}
    </div>
  )
}
