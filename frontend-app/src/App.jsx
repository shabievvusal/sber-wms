import { useEffect, useState } from 'react'
import { Menu } from 'lucide-react'
import { Toaster } from '@/components/ui/sonner'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Sidebar, SidebarNav, findNavLabel } from '@/components/layout/Sidebar'
import LoginPage from '@/components/layout/LoginPage'
import { AuthProvider, useAuth } from '@/context/AuthContext'
import { parseHash, setHash } from '@/lib/hashRoute'
import ShipmentsPage from '@/pages/shipments/ShipmentsPage'
import SettingsPage from '@/pages/settings/SettingsPage'
import ConsolidationPage from '@/pages/consolidation/ConsolidationPage'
import SuppliesPage from '@/pages/supplies/SuppliesPage'
import MonitorPage from '@/pages/monitor/MonitorPage'
import ReportsPage from '@/pages/reports/ReportsPage'
import DocsPage from '@/pages/docs/DocsPage'
import AnalysisPage from '@/pages/analysis/AnalysisPage'
import ReceivePage from '@/pages/receive/ReceivePage'
import TsdIssuePage from '@/pages/tsd/TsdIssuePage'
import PieceSelectionPage from '@/pages/picking/PieceSelectionPage'
import KdkLayoutPage from '@/pages/picking/KdkLayoutPage'
import EoSearchPage from '@/pages/picking/EoSearchPage'
import ShiftPlanPage from '@/pages/shift-plan/ShiftPlanPage'
import ViolationsPage from '@/pages/violations/ViolationsPage'
import ConsolidationFormPage from '@/pages/consolidation-form/ConsolidationFormPage'
import StatsPage from '@/pages/stats/StatsPage'

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
  docs: DocsPage,
  analysis: AnalysisPage,
  receive: ReceivePage,
  tsd: TsdIssuePage,
  'picking-piece': PieceSelectionPage,
  'picking-kdk': KdkLayoutPage,
  'picking-eo': EoSearchPage,
  shift_plan: ShiftPlanPage,
  violations: ViolationsPage,
  'consolidation-form': ConsolidationFormPage,
  stats: StatsPage,
}

export default function App() {
  return (
    <AuthProvider>
      <AppGate />
      <Toaster position="top-right" richColors />
    </AuthProvider>
  )
}

// Жёсткий гейт — без сессии ни одна страница не рендерится, только экран
// входа (как в оригинале). Хэш-роутер (parseHash/setHash) не трогаем, он
// просто скрыт за этим гейтом.
function AppGate() {
  const { user, loading } = useAuth()

  if (loading) return <Spinner label="Загрузка сессии..." className="min-h-screen" />
  if (!user) return <LoginPage />
  return <AppShell />
}

function AppShell() {
  const [route, setRoute] = useState(parseHash)
  const [navOpen, setNavOpen] = useState(false)
  const ActivePage = PAGES[route.page] ?? ShipmentsPage

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = p => { setHash(p); setNavOpen(false) }

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar activePage={route.page} onNavigate={navigate} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Мобильный топ-бар — вместо постоянного бокового меню (Sidebar
            скрыт до `md`, см. Sidebar.jsx). Гамбургер открывает тот же
            SidebarNav в выезжающем слева Sheet. */}
        <div className="sticky top-0 z-30 flex items-center gap-3 border-b bg-card p-3 md:hidden">
          <Button size="icon" variant="ghost" onClick={() => setNavOpen(true)}>
            <Menu className="size-5" />
          </Button>
          <span className="truncate text-sm font-semibold">{findNavLabel(route.page)}</span>
        </div>

        <main className="min-w-0 flex-1 overflow-x-hidden">
          <ActivePage initialId={route.id} />
        </main>
      </div>

      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent
          showClose={false}
          className="inset-y-0 right-auto left-0 w-[240px] max-w-[80vw] gap-0 border-r border-l-0 p-0 data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left"
        >
          <SheetHeader className="flex-row items-center gap-2.5 space-y-0 p-4">
            <img src="/icon.png" alt="logo" className="size-8 shrink-0 object-contain" />
            <div className="min-w-0">
              <SheetTitle className="truncate text-[13px]">СберЛогистика</SheetTitle>
              <div className="truncate text-[10px] text-muted-foreground">WMS Мониторинг</div>
            </div>
          </SheetHeader>
          <SidebarNav activePage={route.page} onNavigate={navigate} />
        </SheetContent>
      </Sheet>
    </div>
  )
}
