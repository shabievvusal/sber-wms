import { useState } from 'react'
import { cn } from '@/lib/utils'
import {
  BarChart2, Monitor, TrendingUp, Users, ScanBarcode, Package, FileText,
  ClipboardList, ListChecks, Boxes, Truck, PackageSearch, AlertTriangle, Settings,
  ChevronLeft, ChevronRight, ChevronDown, UserCircle, LogOut, Combine,
} from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { useAuth } from '@/context/AuthContext'
import { BUILTIN_ROLE_LABELS } from '@/pages/settings/constants'

const LS_KEY = 'sidebar_collapsed'

// Тот же список разделов, что и в оригинальном Layout.jsx (components/layout/Layout.jsx) —
// `page` заполнен только для страниц, которые уже перенесены в new zlp; остальные
// показаны для полноты картины меню, но неактивны («скоро»), а не притворяются рабочими.
// «Комплектация» в оригинале — не отдельная страница, а сворачиваемая группа
// с 3 дочерними страницами (`children`), см. PLAN.md.
// `module` — тот же module-код, что и у ролей (Настройки → Роли,
// AuthConstants.ModulesByRole на бэкенде) — используется и для скрытия
// пунктов меню недоступных ролей (см. `hasModuleAccess`/`SidebarNav`
// ниже), и для гейта прямой навигации по хэшу (App.jsx). Раньше ЭТОГО
// поля не было вообще — роли/доступы в Настройках сохранялись, но их
// никто не читал ни здесь, ни в App.jsx (пользователь 2026-07-16: «роли
// раздал, доступы дал, но они вообще не учитываются!!!») — см. оригинал
// (Layout.jsx's NAV_ITEMS + hasModuleAccess, App.jsx's ModuleRoute).
export const NAV_ITEMS = [
  { key: 'stats', Icon: BarChart2, label: 'Статистика', page: 'stats', module: 'stats' },
  { key: 'monitor', Icon: Monitor, label: 'Мониторинг', page: 'monitor', module: 'monitor' },
  { key: 'analysis', Icon: TrendingUp, label: 'Анализ', page: 'analysis', module: 'analysis' },
  { key: 'shift_plan', Icon: Users, label: 'План смены', page: 'shift_plan', module: 'shift_plan' },
  { key: 'tsd', Icon: ScanBarcode, label: 'Выдача ТСД', page: 'tsd', module: 'tsd' },
  { key: 'consolidation', Icon: Package, label: 'Консолидация', page: 'consolidation', module: 'consolidation' },
  { key: 'docs', Icon: FileText, label: 'Документы', page: 'docs', module: 'docs' },
  {
    key: 'picking', Icon: ClipboardList, label: 'Комплектация', page: null, module: 'picking',
    children: [
      { key: 'picking-piece', Icon: ListChecks, label: 'Штучный отбор', page: 'picking-piece', module: 'picking' },
      { key: 'picking-kdk', Icon: Boxes, label: 'Зависшие задачи', page: 'picking-kdk', module: 'picking' },
      { key: 'picking-eo', Icon: ScanBarcode, label: 'Поиск ЕО', page: 'picking-eo', module: 'picking' },
    ],
  },
  { key: 'shipments', Icon: Truck, label: 'Отгрузка', page: 'shipments', module: 'shipments' },
  { key: 'supplies', Icon: PackageSearch, label: 'Поставки', page: 'supplies', module: 'supplies' },
  { key: 'reports', Icon: ClipboardList, label: 'Отчёты', page: 'reports', module: 'reports' },
  { key: 'stock-consolidation', Icon: Combine, label: 'Объединение остатков', page: 'stock-consolidation', module: 'stock_consolidation' },
  { key: 'violations', Icon: AlertTriangle, label: 'Нарушения', page: 'violations', module: 'violations' },
  { key: 'settings', Icon: Settings, label: 'Настройки', page: 'settings', module: 'settings' },
]

// Страницы вне сайдбара («киоск»-роуты, доступные только напрямую по хэшу,
// как и в оригинале — отдельные top-level роуты вне Layout) — свой module
// каждая, но не пункты меню.
export const HIDDEN_PAGE_MODULES = {
  receive: 'receive',
  'consolidation-form': 'consolidation_form',
}

// 1:1 с оригиналом (Layout.jsx): `stats` доступна всегда, остальное — только
// если модуль есть в списке модулей пользователя (роль или ручной
// override — `resolveModules`/`ResolveModulesAsync` уже мержит это на
// бэкенде, здесь просто читаем готовый `user.modules`).
export function hasModuleAccess(userModules, module) {
  return !module || module === 'stats' || (userModules || []).includes(module)
}

// Заголовок текущей страницы для мобильного топ-бара — ищем и среди верхнего
// уровня, и среди детей групп (сейчас только «Комплектация»).
export function findNavLabel(page) {
  for (const item of NAV_ITEMS) {
    if (item.page === page) return item.label
    const child = item.children?.find(c => c.page === page)
    if (child) return child.label
  }
  return ''
}

// Список пунктов меню — общий для десктопного бокового меню и мобильного
// выезжающего drawer'а (Sheet в App.jsx), чтобы не дублировать разметку и
// логику сворачиваемой группы «Комплектация» в двух местах.
export function SidebarNav({ activePage, onNavigate, collapsed = false }) {
  const { user } = useAuth()
  const userModules = user?.modules || []
  const visibleItems = NAV_ITEMS
    .filter(item => hasModuleAccess(userModules, item.module))
    .map(item => item.children ? { ...item, children: item.children.filter(c => hasModuleAccess(userModules, c.module)) } : item)

  const [expanded, setExpanded] = useState(() => {
    const initial = new Set()
    for (const item of NAV_ITEMS) {
      if (item.children?.some(c => c.page === activePage)) initial.add(item.key)
    }
    return initial
  })

  const toggleGroup = key => setExpanded(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })

  return (
    <nav className="flex flex-1 flex-col gap-px overflow-y-auto overflow-x-hidden py-2">
      {visibleItems.map(({ key, Icon, label, page, children }) => {
        const active = page && page === activePage
        const disabled = !page && !children
        const isGroup = !!children
        const groupActive = isGroup && children.some(c => c.page === activePage)
        const isExpanded = expanded.has(key)

        const itemButton = (
          <button
            key={key}
            type="button"
            disabled={disabled}
            title={collapsed ? label + (disabled ? ' (скоро)' : '') : undefined}
            onClick={() => {
              if (isGroup) { collapsed ? onNavigate(children[0].page) : toggleGroup(key) }
              else if (page) onNavigate(page)
            }}
            className={cn(
              'group flex w-full items-center gap-2.5 border-l-[3px] border-l-transparent px-4 py-2 text-left text-[13px] font-medium text-muted-foreground transition-colors',
              collapsed && 'justify-center px-0 py-2.5',
              (!disabled || isGroup) && 'hover:bg-muted hover:text-foreground',
              (active || groupActive) && 'border-l-primary bg-accent font-semibold text-accent-foreground',
              disabled && !isGroup && 'cursor-default opacity-40',
            )}
          >
            <Icon size={17} strokeWidth={1.75} className="shrink-0" />
            {!collapsed && <span className="truncate">{label}</span>}
            {!collapsed && disabled && !isGroup && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">скоро</span>}
            {!collapsed && isGroup && <ChevronDown size={13} className={cn('ml-auto shrink-0 transition-transform', !isExpanded && '-rotate-90')} />}
          </button>
        )

        if (!isGroup) return itemButton

        return (
          <div key={key}>
            {itemButton}
            {!collapsed && isExpanded && children.map(child => {
              const childActive = child.page === activePage
              return (
                <button
                  key={child.key}
                  type="button"
                  onClick={() => onNavigate(child.page)}
                  className={cn(
                    'flex w-full items-center gap-2.5 border-l-[3px] border-l-transparent py-1.5 pl-9 pr-4 text-left text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                    childActive && 'border-l-primary bg-accent font-semibold text-accent-foreground',
                  )}
                >
                  <child.Icon size={15} strokeWidth={1.75} className="shrink-0" />
                  <span className="truncate">{child.label}</span>
                </button>
              )
            })}
          </div>
        )
      })}
    </nav>
  )
}

// Пользователь + разлогин — реальная сессия (AuthContext), тот же паттерн
// Popover, что и в FilterDropdown.jsx.
function UserMenu({ collapsed }) {
  const { user, logout } = useAuth()
  const roleLabel = BUILTIN_ROLE_LABELS[user?.role] || user?.role

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-muted',
            collapsed && 'flex-none justify-center',
          )}
        >
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-accent text-primary">
            <UserCircle size={18} strokeWidth={1.75} />
          </div>
          {!collapsed && <span className="truncate text-xs font-medium">{user?.name || 'Без имени'}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-56 p-1.5">
        <div className="space-y-0.5 px-2 py-1.5">
          <div className="truncate text-sm font-medium">{user?.name || 'Без имени'}</div>
          <div className="truncate text-xs text-muted-foreground">{roleLabel}</div>
        </div>
        <div className="my-1 border-t" />
        <button
          type="button"
          onClick={logout}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
        >
          <LogOut size={15} strokeWidth={1.75} />
          Выйти из аккаунта
        </button>
      </PopoverContent>
    </Popover>
  )
}

// Десктопное боковое меню — скрыто на мобильном (`hidden md:flex`, см.
// App.jsx), там вместо него тонкий топ-бар с гамбургером, открывающим Sheet
// с тем же SidebarNav внутри.
export function Sidebar({ activePage, onNavigate }) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(LS_KEY) === '1' } catch { return false }
  })

  const toggle = () => setCollapsed(v => {
    const next = !v
    try { localStorage.setItem(LS_KEY, next ? '1' : '0') } catch { /* ignore */ }
    return next
  })

  return (
    <aside className={cn('sticky top-0 hidden h-screen shrink-0 flex-col border-r bg-card transition-[width] duration-200 md:flex', collapsed ? 'w-14' : 'w-[200px]')}>
      <div className={cn('flex items-center gap-2.5 border-b p-4', collapsed && 'justify-center p-4')}>
        <img src="/icon.png" alt="logo" className="size-8 shrink-0 object-contain" />
        {!collapsed && (
          <div className="min-w-0">
            <div className="truncate text-[13px] font-bold leading-tight">СберЛогистика</div>
            <div className="truncate text-[10px] text-muted-foreground">WMS Мониторинг</div>
          </div>
        )}
      </div>

      <SidebarNav activePage={activePage} onNavigate={onNavigate} collapsed={collapsed} />

      <div className={cn('flex items-center gap-1 border-t p-2', collapsed && 'flex-col')}>
        <UserMenu collapsed={collapsed} />
        <button
          type="button"
          onClick={toggle}
          title={collapsed ? 'Развернуть' : 'Свернуть'}
          className="flex size-[22px] shrink-0 items-center justify-center rounded-full border text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-primary"
        >
          {collapsed ? <ChevronRight size={13} strokeWidth={2.5} /> : <ChevronLeft size={13} strokeWidth={2.5} />}
        </button>
      </div>
    </aside>
  )
}
