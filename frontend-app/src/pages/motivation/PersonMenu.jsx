import { useState } from 'react'
import { UserPlus, UserPen, KeyRound, Trash2, ChevronRight, Check } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

function MenuItem({ icon: Icon, children, onClick, destructive, trailing }) {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent',
        destructive && 'text-destructive',
      )}
      onClick={onClick}
    >
      {Icon ? <Icon className="size-4 shrink-0 opacity-70" /> : <span className="size-4 shrink-0" />}
      <span className="flex-1">{children}</span>
      {trailing}
    </button>
  )
}

// Поле ввода внутри меню (новое ФИО / учётка): Enter — применить, Esc — назад.
function MenuInput({ label, initial, placeholder, list, onSubmit, onCancel }) {
  const [value, setValue] = useState(initial)
  return (
    <div className="space-y-1.5 p-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <Input
        autoFocus className="h-8 text-sm" value={value} placeholder={placeholder} list={list}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && value.trim()) onSubmit(value.trim())
          if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        }}
      />
      <div className="text-[11px] text-muted-foreground">Enter — применить, Esc — назад</div>
    </div>
  )
}

/**
 * Меню по клику (левой или правой кнопкой) на сотрудника.
 * Для строки смены (`inShift`) — ФИО/учётка/роль/удаление; для учётки из
 * статистики — внести в акт (как есть, под другим ФИО, без нормы).
 */
export function PersonMenu({ row, inShift, onRename, onChangeAccount, onSetRole, onDelete, onAdd }) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(null) // null | 'fio' | 'account' | 'addAs'

  const close = () => { setOpen(false); setStep(null) }
  const run = fn => async (...args) => { close(); await fn(...args) }

  return (
    <Popover open={open} onOpenChange={v => { setOpen(v); if (!v) setStep(null) }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded px-1 -mx-1 text-left font-medium underline-offset-4 hover:bg-accent hover:underline"
          onContextMenu={e => { e.preventDefault(); setOpen(true) }}
        >
          {row.fio}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1">
        <div className="border-b px-2 pb-1.5 pt-1 text-xs text-muted-foreground">
          {row.fio}
          {(row.executorId || row.executorName) && row.executorName !== row.fio && (
            <> · учётка {row.executorName || row.executorId}</>
          )}
        </div>

        {step === 'fio' && (
          <MenuInput label="ФИО в акте" initial={row.fio} onCancel={() => setStep(null)} onSubmit={run(onRename)} />
        )}
        {step === 'account' && (
          <MenuInput
            label="Учётка (ID или ФИО учётки)" initial={row.executorId || row.executorName}
            list="motivation-accounts" placeholder="Начните вводить…"
            onCancel={() => setStep(null)} onSubmit={run(onChangeAccount)}
          />
        )}
        {step === 'addAs' && (
          <MenuInput
            label="ФИО человека из акта" initial="" placeholder="Кто работал под этой учёткой"
            onCancel={() => setStep(null)} onSubmit={run(fio => onAdd({ fio }))}
          />
        )}

        {step === null && inShift && (
          <div className="pt-1">
            <MenuItem icon={UserPen} onClick={() => setStep('fio')} trailing={<ChevronRight className="size-3.5 opacity-50" />}>
              Изменить ФИО
            </MenuItem>
            <MenuItem icon={KeyRound} onClick={() => setStep('account')} trailing={<ChevronRight className="size-3.5 opacity-50" />}>
              {row.executorId || row.executorName ? 'Сменить учётку' : 'Указать учётку'}
            </MenuItem>
            <div className="my-1 border-t" />
            <MenuItem onClick={run(() => onSetRole('picker'))} trailing={row.role === 'picker' && <Check className="size-4" />}>
              Комплектовщик (по норме)
            </MenuItem>
            <MenuItem onClick={run(() => onSetRole('other'))} trailing={row.role === 'other' && <Check className="size-4" />}>
              Без нормы — полная смена
            </MenuItem>
            <div className="my-1 border-t" />
            <MenuItem icon={Trash2} destructive onClick={run(onDelete)}>Удалить из смены</MenuItem>
          </div>
        )}

        {step === null && !inShift && (
          <div className="pt-1">
            <MenuItem icon={UserPlus} onClick={run(() => onAdd({}))}>Внести в акт</MenuItem>
            <MenuItem icon={UserPen} onClick={() => setStep('addAs')} trailing={<ChevronRight className="size-3.5 opacity-50" />}>
              Внести в акт под другим ФИО
            </MenuItem>
            <MenuItem onClick={run(() => onAdd({ role: 'other' }))}>Внести без нормы (полная смена)</MenuItem>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
