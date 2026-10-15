import { useMemo, useRef, useState } from 'react'
import { Check, Search } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAuth } from '@/context/AuthContext'
import { useWarehouse, shortWarehouseName, switchWarehouse } from '@/lib/warehouse'
import { cn } from '@/lib/utils'

/** Название выбранного склада (под «СберЛогистика» в шапке меню). */
export function WarehouseLabel({ className }) {
  const { user } = useAuth()
  const { warehouse } = useWarehouse(user)
  return (
    <div className={cn('truncate text-xs text-muted-foreground', className)} title={warehouse?.name}>
      {warehouse ? shortWarehouseName(warehouse.name) : '—'}
    </div>
  )
}

/** Сколько складов у пользователя (кнопка «Сменить склад» — только если больше одного). */
export function useWarehouseCount() {
  const { user } = useAuth()
  return (user?.warehouses || []).length
}

/** Выбор склада: trigger — кнопка, по которой открывается список (с поиском,
 *  когда складов много — у разработчика их больше 20). Смена склада
 *  перезагружает страницу: роль, разделы и данные на каждом складе свои. */
export function WarehousePicker({ children, side = 'right', align = 'end' }) {
  const { user } = useAuth()
  const { id, list } = useWarehouse(user)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchRef = useRef(null)

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = list.map(w => ({ ...w, short: shortWarehouseName(w.name) }))
      .sort((a, b) => a.short.localeCompare(b.short, 'ru'))
    return q ? all.filter(w => w.name.toLowerCase().includes(q)) : all
  }, [list, query])

  const choose = wid => { setOpen(false); setQuery(''); switchWarehouse(wid) }

  return (
    <Popover open={open} onOpenChange={o => { setOpen(o); if (!o) setQuery('') }}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        className="w-64 p-1.5"
        onOpenAutoFocus={e => { if (searchRef.current) { e.preventDefault(); searchRef.current.focus() } }}
      >
        <div className="px-2 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Сменить склад</div>
        {list.length > 6 && (
          <div className="relative mb-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={searchRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && items[0]) choose(items[0].id) }}
              placeholder="Найти склад"
              className="h-8 w-full rounded-lg border border-line bg-surface pl-8 pr-2 text-sm outline-none focus:border-brand"
            />
          </div>
        )}
        <div className="max-h-72 overflow-y-auto">
          {items.map(w => (
            <button
              key={w.id}
              type="button"
              onClick={() => choose(w.id)}
              title={w.name}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-2',
                w.id === id && 'font-medium text-brand',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{w.short}</span>
              {w.id === id && <Check className="size-4 shrink-0" />}
            </button>
          ))}
          {items.length === 0 && <div className="px-2 py-3 text-center text-sm text-muted-foreground">Не найдено</div>}
        </div>
      </PopoverContent>
    </Popover>
  )
}
