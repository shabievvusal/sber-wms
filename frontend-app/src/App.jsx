import { useEffect, useState } from 'react'
import { Menu } from 'lucide-react'
import { Toaster } from '@/components/ui/sonner'
import { ConfirmHost } from '@/components/ui/confirm'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Sidebar, MobileDrawer, MobileUserMenu, findNavLabel, NAV_ITEMS, HIDDEN_PAGE_MODULES, hasModuleAccess } from '@/components/layout/Sidebar'
import LoginPage from '@/components/layout/LoginPage'
import { AuthProvider, useAuth } from '@/context/AuthContext'
import { parseHash, setHash } from '@/lib/hashRoute'
import { EoAutoRefresh } from '@/lib/eoAutoRefresh'
import { usePresence } from '@/lib/presence'
import { isEmbedded, initEmbedBridge, postEmbedUser, setEmbedLogout } from '@/lib/embed'
import ShipmentsPage from '@/pages/shipments/ShipmentsPage'
import SettingsPage from '@/pages/settings/SettingsPage'
import ConsolidationPage from '@/pages/consolidation/ConsolidationPage'
import SuppliesPage from '@/pages/supplies/SuppliesPage'
import MonitorPage from '@/pages/monitor/MonitorPage'
import ReportsPage from '@/pages/reports/ReportsPage'
import ReceivePage from '@/pages/receive/ReceivePage'
import TsdIssuePage from '@/pages/tsd/TsdIssuePage'
import PieceSelectionPage from '@/pages/picking/PieceSelectionPage'
import KdkLayoutPage from '@/pages/picking/KdkLayoutPage'
import KdkPlacementPage from '@/pages/picking/KdkPlacementPage'
import EoSearchPage from '@/pages/picking/EoSearchPage'
import PickingGapsPage from '@/pages/picking/PickingGapsPage'
import MotivationPage from '@/pages/motivation/MotivationPage'
import ViolationsPage from '@/pages/violations/ViolationsPage'
import ConsolidationFormPage from '@/pages/consolidation-form/ConsolidationFormPage'
import StatsPage from '@/pages/stats/StatsPage'
import StockConsolidationPage from '@/pages/stock-consolidation/StockConsolidationPage'
import ExtensionPage from '@/pages/extension/ExtensionPage'

// Песочница дизайна без роутера — переключение между готовыми страницами
// через боковое меню (Sidebar.jsx), как в оригинальном Layout.jsx, вместо
// полноценного react-router. Текущая страница (и, для «Поставок», открытая
// поставка) синхронизирована с location.hash — так у строк поставок может
// быть настоящий href для правого клика/новой вкладки, см. hashRoute.js.
const PAGES = {
  shipments: ShipmentsPage,
  settings: SettingsPage,
  consolidation: ConsolidationPage,
  supplies: SuppliesPage,
  monitor: MonitorPage,
  reports: ReportsPage,
  'stock-consolidation': StockConsolidationPage,
  receive: ReceivePage,
  tsd: TsdIssuePage,
  'picking-piece': PieceSelectionPage,
  'picking-kdk': KdkLayoutPage,
  'picking-kdk-layout': KdkPlacementPage,
  'picking-eo': EoSearchPage,
  'picking-gaps': PickingGapsPage,
  motivation: MotivationPage,
  violations: ViolationsPage,
  'consolidation-form': ConsolidationFormPage,
  stats: StatsPage,
  // без модуля — доступна всем вошедшим (ссылка внизу бокового меню)
  extension: ExtensionPage,
}

// page → module, для гейта доступа (см. `hasModuleAccess`/App.jsx ниже) —
// собран из самого NAV_ITEMS (единственный источник правды для пунктов
// меню) плюс «киоск»-страницы вне меню (HIDDEN_PAGE_MODULES).
const PAGE_MODULE = { ...HIDDEN_PAGE_MODULES }
for (const item of NAV_ITEMS) {
  if (item.page) PAGE_MODULE[item.page] = item.module
  for (const child of item.children || []) PAGE_MODULE[child.page] = child.module
}

export default function App() {
  return (
    <AuthProvider>
      <AppGate />
      <Toaster position="top-right" richColors />
      <ConfirmHost />
    </AuthProvider>
  )
}

// Жёсткий гейт — без сессии ни одна страница не рендерится, только экран
// входа (как в оригинале). Хэш-роутер (parseHash/setHash) не трогаем, он
// просто скрыт за этим гейтом.
function AppGate() {
  const { user, loading, logout } = useAuth()
  // во встроенном в WMS режиме — имя и «Выйти» показывает расширение (lib/embed.js)
  useEffect(() => { if (!loading) postEmbedUser(user) }, [user, loading])
  useEffect(() => { setEmbedLogout(logout) }, [logout])

  if (loading) return <Spinner label="Загрузка сессии..." className="min-h-screen" />
  if (!user) return <LoginPage />
  return <AppShell />
}

function AppShell() {
  const { user } = useAuth()
  const [route, setRoute] = useState(parseHash)
  const [navOpen, setNavOpen] = useState(false)
  usePresence(!!user) // «Был в сети» в Настройках → Пользователи
  // встроено в WMS расширением: разделы переключает меню WMS (см. lib/embed.js)
  useEffect(() => initEmbedBridge({ onNavigate: p => setHash(p) }), [])

  // Гейт по модулю роли (1:1 с оригиналом — ModuleRoute в App.jsx) —
  // до этого проверка была ТОЛЬКО в голове у пользователя: роли/доступы
  // сохранялись в Настройках, но ни пункты меню, ни сама навигация их не
  // читали вообще (пользователь 2026-07-16: «роли раздал, доступы дал, но
  // они вообще не учитываются!!!»). Пункты меню отфильтрованы в
  // SidebarNav — это вторая линия защиты для прямой навигации по хэшу
  // (набранный вручную URL, старая закладка, роль поменяли только что).
  const requiredModule = PAGE_MODULE[route.page]
  const allowed = hasModuleAccess(user?.modules, requiredModule)
  const ActivePage = allowed ? (PAGES[route.page] ?? ShipmentsPage) : StatsPage

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    if (!allowed && route.page !== 'stats') setHash('stats')
  }, [allowed, route.page])

  const navigate = p => { setHash(p); setNavOpen(false) }

  return (
    <div className="flex min-h-screen bg-background">
      {/* Фоновое обновление списков ЕО — работает только на устройстве с
          включённым автообновлением и живой WMS-сессией, на всех остальных
          это no-op (см. eoAutoRefresh.jsx). Здесь, а не на странице приёмки:
          обновлять должен корп. компьютер, где открыта другая страница. */}
      <EoAutoRefresh />
      {!isEmbedded && <Sidebar activePage={route.page} onNavigate={navigate} />}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Мобильный топ-бар — вместо постоянного бокового меню (Sidebar
            скрыт до `md`, см. Sidebar.jsx). Гамбургер открывает тот же
            SidebarNav в выезжающей слева панели (MobileDrawer). */}
        <div className={isEmbedded ? 'hidden' : 'sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-[var(--glass)] p-3 backdrop-blur-xl md:hidden print:hidden'}>
          <Button size="icon" variant="ghost" onClick={() => setNavOpen(true)} aria-label="Открыть меню">
            <Menu className="size-5" />
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">{findNavLabel(route.page)}</span>
          <MobileUserMenu />
        </div>

        <main key={route.page} className="page-in min-w-0 flex-1 overflow-x-clip">
          <ActivePage initialId={route.id} initialSub={route.sub} />
        </main>
      </div>

      {!isEmbedded && <MobileDrawer open={navOpen} onOpenChange={setNavOpen} activePage={route.page} onNavigate={navigate} />}
    </div>
  )
}
