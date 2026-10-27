import { useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { AnimatePresence, motion } from 'motion/react'
import { cn } from '@/lib/utils'
import {
  BarChart2, Monitor, ScanBarcode, ScanSearch, Package, CalendarClock,
  ClipboardList, ListChecks, Boxes, LayoutGrid, Truck, PackageSearch, AlertTriangle, Settings,
  ChevronDown, LogOut, ArrowLeftRight, Combine, Award, Warehouse, PanelLeftClose, PanelLeftOpen, X, Puzzle,
} from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { WarehouseLabel, WarehousePicker, useWarehouseCount } from '@/components/layout/WarehouseSwitcher'
import { useAuth } from '@/context/AuthContext'
import { ROLE_LABELS } from '@/pages/settings/constants'

const LS_KEY = 'sidebar_collapsed'
const spring = { type: 'spring', stiffness: 500, damping: 40 }

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
  { key: 'motivation', Icon: Award, label: 'Мотивация', page: 'motivation', module: 'motivation' },
  { key: 'tsd', Icon: ScanBarcode, label: 'Выдача ТСД', page: 'tsd', module: 'tsd' },
  { key: 'consolidation', Icon: Package, label: 'Консолидация', page: 'consolidation', module: 'consolidation' },
  {
    key: 'picking', Icon: ClipboardList, label: 'Комплектация', page: null, module: 'picking',
    children: [
      { key: 'picking-piece', Icon: ListChecks, label: 'Штучный отбор', page: 'picking-piece', module: 'picking' },
      { key: 'picking-kdk-layout', Icon: LayoutGrid, label: 'Раскладка КДК', page: 'picking-kdk-layout', module: 'picking' },
      { key: 'picking-kdk', Icon: Boxes, label: 'Зависшие задачи', page: 'picking-kdk', module: 'picking' },
      { key: 'picking-eo', Icon: ScanBarcode, label: 'Поиск ЕО', page: 'picking-eo', module: 'picking' },
      { key: 'picking-lost-eo', Icon: ScanSearch, label: 'Поиск потеряшек', page: 'picking-lost-eo', module: 'picking' },
      { key: 'picking-gaps', Icon: AlertTriangle, label: 'Пропуски в отборе', page: 'picking-gaps', module: 'picking' },
    ],
  },
  { key: 'shipments', Icon: Truck, label: 'Отгрузка', page: 'shipments', module: 'shipments' },
  { key: 'supplies', Icon: PackageSearch, label: 'Поставки', page: 'supplies', module: 'supplies' },
  { key: 'supply-plan', Icon: CalendarClock, label: 'График поставок', page: 'supply-plan', module: 'supplies' },
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
  if (page === 'extension') return 'Расширение для WMS'
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
// Оформление — как в WMS (supervisor/Layout.tsx): активный пункт подсвечен
// «переезжающей» подложкой (motion layoutId). `layoutPrefix` различает
// экземпляры меню, иначе подложка анимировалась бы между ними.
const itemCls = (active, collapsed) => cn(
  'relative flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors',
  active ? 'text-foreground' : 'text-ink-2 hover:text-foreground',
  collapsed && 'justify-center px-0',
)

function ActivePill({ layoutId }) {
  return <motion.span layoutId={layoutId} transition={spring} className="absolute inset-0 rounded-xl bg-surface-2 ring-1 ring-line" />
}

export function SidebarNav({ activePage, onNavigate, collapsed = false, layoutPrefix = 'nav' }) {
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

  const pillId = `${layoutPrefix}-active`

  return (
    <nav className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-1">
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
            className={cn(itemCls(active || groupActive, collapsed), disabled && !isGroup && 'cursor-default opacity-40')}
          >
            {(active || (groupActive && (collapsed || !isExpanded))) && <ActivePill layoutId={pillId} />}
            <Icon size={17} strokeWidth={active || groupActive ? 2.4 : 2} className="relative shrink-0" />
            {!collapsed && <span className="relative truncate">{label}</span>}
            {!collapsed && disabled && !isGroup && <span className="relative ml-auto shrink-0 text-[10px] text-muted-foreground">скоро</span>}
            {!collapsed && isGroup && <ChevronDown size={15} className={cn('relative ml-auto shrink-0 text-muted-foreground transition-transform', !isExpanded && '-rotate-90')} />}
          </button>
        )

        if (!isGroup) return itemButton

        return (
          <div key={key}>
            {itemButton}
            <AnimatePresence initial={false}>
              {!collapsed && isExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="overflow-hidden"
                >
                  <div className="ml-[21px] flex flex-col gap-0.5 border-l border-line py-0.5 pl-2">
                    {children.map(child => {
                      const childActive = child.page === activePage
                      return (
                        <button
                          key={child.key}
                          type="button"
                          onClick={() => onNavigate(child.page)}
                          className={cn(itemCls(childActive), 'py-1.5')}
                        >
                          {childActive && <ActivePill layoutId={pillId} />}
                          <span className="relative truncate">{child.label}</span>
                        </button>
                      )
                    })}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )
      })}
    </nav>
  )
}

/** Логотип: градиентная плитка + название (как Brand в WMS). */
export function Brand({ compact = false }) {
  return (
    <div className={cn('flex items-center gap-3', compact && 'justify-center')}>
      <div className="bg-brand-gradient grid size-10 shrink-0 place-items-center rounded-2xl text-white shadow-card">
        <Warehouse size={19} strokeWidth={2.2} />
      </div>
      {!compact && (
        <div className="min-w-0 leading-tight">
          <div className="truncate font-semibold tracking-tight">СберЛогистика</div>
          {/* склад — вместо роли (роль видна внизу, у имени); сменить — у «Выйти» */}
          <WarehouseLabel />
        </div>
      )}
    </div>
  )
}

const initials = name => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase()

/** Кто вошёл: инициалы, ФИО, роль и выход — как UserBlock в WMS. */
function UserBlock({ collapsed, popoverSide = 'right', popoverAlign = 'end', themeId = 'collapsed-theme' }) {
  const { user, logout } = useAuth()
  // складов несколько — рядом с «Выйти» кнопка «Сменить склад»
  const manyWarehouses = useWarehouseCount() > 1
  const name = user?.name || 'Без имени'
  const roleLabel = ROLE_LABELS[user?.role] || user?.role

  const avatar = (
    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-soft text-sm font-semibold text-brand">
      {initials(user?.name)}
    </span>
  )

  if (collapsed) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" title={name} className="mx-auto block rounded-xl transition-opacity hover:opacity-80">{avatar}</button>
        </PopoverTrigger>
        <PopoverContent align={popoverAlign} side={popoverSide} className="w-60 p-1.5">
          <div className="space-y-0.5 px-2 py-1.5">
            <div className="truncate text-sm font-medium">{name}</div>
            <div className="truncate text-xs text-muted-foreground">{roleLabel}</div>
          </div>
          <div className="my-1 border-t border-line" />
          <div className="flex justify-center py-1"><ThemeToggle id={themeId} /></div>
          <div className="my-1 border-t border-line" />
          {manyWarehouses && (
            <WarehousePicker side={popoverSide} align="start">
              <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2">
                <ArrowLeftRight size={15} />
                Сменить склад
              </button>
            </WarehousePicker>
          )}
          <button
            type="button"
            onClick={logout}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
          >
            <LogOut size={15} />
            Выйти из аккаунта
          </button>
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <div className="flex items-center gap-2.5">
      {avatar}
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-sm font-medium" title={name}>{name}</div>
        <div className="truncate text-xs text-muted-foreground">{roleLabel}</div>
      </div>
      {manyWarehouses && (
        <WarehousePicker>
          <button
            type="button"
            title="Сменить склад"
            className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <ArrowLeftRight size={15} />
          </button>
        </WarehousePicker>
      )}
      <button
        type="button"
        title="Выйти"
        onClick={logout}
        className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-2 hover:text-destructive"
      >
        <LogOut size={15} />
      </button>
    </div>
  )
}

/** Ссылка на страницу «Расширение для WMS» (внизу меню). */
function ExtensionLink({ activePage, onNavigate, collapsed }) {
  const active = activePage === 'extension'
  return (
    <button
      type="button"
      onClick={() => onNavigate('extension')}
      title="Расширение для WMS — разделы сайта прямо в меню WMS"
      className={cn(
        'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-medium transition-colors',
        active ? 'bg-brand-soft text-brand' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
        collapsed && 'justify-center px-0',
      )}
    >
      <Puzzle className="size-4 shrink-0" />
      {!collapsed && <span className="truncate">Расширение для WMS</span>}
    </button>
  )
}

// Десктопное боковое меню — скрыто на мобильном (`hidden md:flex`, см.
// App.jsx), там вместо него топ-бар с гамбургером, открывающим Sheet
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
    <aside
      className={cn(
        'sticky top-0 hidden h-screen shrink-0 flex-col gap-5 border-r border-line bg-surface py-5 transition-[width] duration-200 md:flex print:hidden',
        collapsed ? 'w-[72px] px-3' : 'w-[248px] px-4',
      )}
    >
      <div className="px-1"><Brand compact={collapsed} /></div>

      <SidebarNav activePage={activePage} onNavigate={onNavigate} collapsed={collapsed} layoutPrefix="sidebar" />

      <div className="space-y-3 px-1">
        <ExtensionLink activePage={activePage} onNavigate={onNavigate} collapsed={collapsed} />
        <div className={cn('flex items-center', collapsed ? 'justify-center' : 'justify-between')}>
          {!collapsed && <ThemeToggle id="sidebar-theme" />}
          <button
            type="button"
            onClick={toggle}
            title={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
            className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>
        <div className="border-t border-line pt-3">
          <UserBlock collapsed={collapsed} />
        </div>
      </div>
    </aside>
  )
}

/** Аватар в мобильной верхней панели: имя, тема и выход — без открытия меню. */
export function MobileUserMenu() {
  return <UserBlock collapsed popoverSide="bottom" popoverAlign="end" themeId="topbar-theme" />
}

// Мобильное меню (до `md`): панель слева с затемнением фона. Анимация —
// motion (выезд пружиной, уход быстрым ease-in), а не классы tw-animate:
// у Sheet по умолчанию заданы анимации «справа», и вместе с классами «слева»
// панель выезжала и уезжала не с той стороны. Закрывается тапом по фону,
// Escape, крестиком или свайпом влево. Внизу — тема и выход из аккаунта.
const drawerIn = { type: 'spring', stiffness: 420, damping: 40, mass: 0.9 }
const drawerOut = { duration: 0.18, ease: [0.4, 0, 1, 1] }

export function MobileDrawer({ open, onOpenChange, activePage, onNavigate }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] md:hidden"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: 0.2 } }}
                exit={{ opacity: 0, transition: { duration: 0.18 } }}
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content asChild forceMount aria-describedby={undefined}>
              <motion.aside
                className="fixed inset-y-0 left-0 z-50 flex w-[288px] max-w-[85vw] flex-col gap-5 rounded-r-3xl border-r border-line bg-surface px-4 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-float outline-none md:hidden"
                initial={{ x: '-100%' }}
                animate={{ x: 0, transition: drawerIn }}
                exit={{ x: '-100%', transition: drawerOut }}
                drag="x"
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={{ left: 0.6, right: 0 }}
                onDragEnd={(_, info) => {
                  if (info.offset.x < -80 || info.velocity.x < -400) onOpenChange(false)
                }}
              >
                <DialogPrimitive.Title className="sr-only">Меню</DialogPrimitive.Title>
                <div className="flex items-center justify-between gap-2 px-1">
                  <Brand />
                  <DialogPrimitive.Close
                    className="grid size-9 shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
                    aria-label="Закрыть меню"
                  >
                    <X size={18} />
                  </DialogPrimitive.Close>
                </div>

                <SidebarNav activePage={activePage} onNavigate={onNavigate} layoutPrefix="drawer" />

                <div className="space-y-3 px-1">
                  <ExtensionLink activePage={activePage} onNavigate={onNavigate} />
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">Тема</span>
                    <ThemeToggle id="drawer-theme" />
                  </div>
                  <div className="border-t border-line pt-3">
                    <UserBlock />
                  </div>
                </div>
              </motion.aside>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  )
}
