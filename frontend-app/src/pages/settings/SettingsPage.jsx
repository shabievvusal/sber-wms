import { useEffect, useState } from 'react'
import * as api from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { rolesOrBuiltin, BUILTIN_ROLE_LABELS } from './constants'
import { EmployeesCard } from './EmployeesCard'
import { MyModulesCard } from './MyModulesCard'
import { PendingCard } from './PendingCard'
import { RolesCard } from './RolesCard'
import { UsersCard } from './UsersCard'
import { DocsCard } from './DocsCard'
import { SupervisorsCard } from './SupervisorsCard'
import { AutoFetchCard } from './AutoFetchCard'
import { ShipmentsDesignCard } from './ShipmentsDesignCard'
import { TsdSettingsCard, TsdManualEmployeesCard } from './TsdSettingsCard'
import { ProductWeightsCard } from './ProductWeightsCard'
import { ZonesSettingsCard } from './ZonesSettingsCard'
import { DeleteShiftDataCard } from './DeleteShiftDataCard'
import { Users, Lock, FileText, Settings as SettingsIcon } from 'lucide-react'

const TAB_DEFS = [
  { key: 'employees', label: 'Сотрудники', Icon: Users },
  { key: 'access', label: 'Доступ', Icon: Lock },
  { key: 'docs', label: 'Документы', Icon: FileText },
  { key: 'system', label: 'Система', Icon: SettingsIcon },
]

export default function SettingsPage() {
  const { user: currentUser } = useAuth()
  const [roles, setRoles] = useState([])
  const [emplCompanies, setEmplCompanies] = useState([])
  const [error, setError] = useState('')

  useEffect(() => {
    api.getVsAdminRoles().then(setRoles).catch(err => { setRoles([]); setError(err.message || 'Не удалось загрузить роли') })
    api.getEmployees().then(d => setEmplCompanies(d.companies || [])).catch(() => setEmplCompanies([]))
  }, [])

  const handleRolesChanged = payload => {
    if (!payload) { api.getVsAdminRoles().then(setRoles).catch(() => {}); return }
    if (payload.type === 'add') setRoles(prev => [...prev, payload.role])
    else if (payload.type === 'update') setRoles(prev => prev.map(r => r.key === payload.key ? { ...r, label: payload.label, modules: payload.modules } : r))
    else if (payload.type === 'delete') setRoles(prev => prev.filter(r => r.key !== payload.key))
  }

  const isManager = currentUser?.role === 'manager'
  const isNonManager = !isManager

  // Менеджеру в оригинале был доступен только раздел Telegram — после его
  // удаления (бот больше не используется) у менеджера в Настройках нет ни
  // одной секции, это отражает реальные права доступа, а не баг вёрстки.
  const visibleTabs = isNonManager ? TAB_DEFS : []

  const [activeTab, setActiveTab] = useState('employees')
  useEffect(() => {
    if (!visibleTabs.some(t => t.key === activeTab)) setActiveTab(visibleTabs[0]?.key ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.role])

  const roleLabel = BUILTIN_ROLE_LABELS[currentUser?.role] || currentUser?.role

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Настройки</h1>
        <p className="text-sm text-muted-foreground">Пользователи, роли и служебные параметры</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          {error}
        </div>
      )}

      {!visibleTabs.length ? (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          Для роли «{roleLabel}» в разделе «Настройки» нет доступных секций.
        </div>
      ) : (
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            {visibleTabs.map(({ key, label, Icon }) => (
              <TabsTrigger key={key} value={key} className="gap-1.5"><Icon className="size-3.5" /> {label}</TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="employees" className="space-y-4">
            <EmployeesCard />
          </TabsContent>

          <TabsContent value="access" className="space-y-4">
            <MyModulesCard currentUser={currentUser} />
            <PendingCard roles={roles} />
            <RolesCard roles={rolesOrBuiltin(roles)} onChanged={handleRolesChanged} />
            <UsersCard roles={roles} currentUser={currentUser} emplCompanies={emplCompanies} />
          </TabsContent>

          <TabsContent value="docs" className="space-y-4">
            <SupervisorsCard />
            <DocsCard />
          </TabsContent>

          <TabsContent value="system" className="space-y-4">
            <AutoFetchCard isAdmin={currentUser?.role === 'admin'} />
            <ShipmentsDesignCard />
            <TsdSettingsCard />
            <TsdManualEmployeesCard />
            <ProductWeightsCard />
            <ZonesSettingsCard />
            {(currentUser?.role === 'admin' || currentUser?.role === 'developer') && <DeleteShiftDataCard />}
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}
