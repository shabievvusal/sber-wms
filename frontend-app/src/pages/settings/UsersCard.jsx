import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { SettingCard } from './SettingCard'
import { EditUserDialog } from './EditUserDialog'
import { rolesToLabelMap, rolesOrBuiltin } from './constants'
import { Avatar, IconAction, ListPager, ModuleChips, clampPage } from './ui'
import { KeyRound, Pencil, Plus, Search, Trash2, Users } from 'lucide-react'

const PAGE_SIZE = 20
const phone10 = v => String(v || '').replace(/\D/g, '').slice(-10)

function fmtDateTime(iso) {
  if (!iso) return null
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function UsersCard({ roles, currentUser, emplCompanies }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [editUser, setEditUser] = useState(null) // null closed, {} new, {...} edit
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const load = () => {
    setLoading(true)
    return withMinDuration(async () => {
      try { setUsers(await api.getVsAdminUsers()) }
      catch { setUsers([]) }
    }).finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const handleDelete = async u => {
    if (!confirm(`Забрать доступ у ${u.name || u.login}?`)) return
    try {
      await api.deleteVsAdminUser(u.login)
      setUsers(prev => prev.filter(x => x.login !== u.login))
      toast.success('Доступ удалён')
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    }
  }

  const roleLabelsMap = rolesToLabelMap(rolesOrBuiltin(roles))
  const withAccess = users.filter(u => u.hasAccess).length

  const q = search.trim().toLowerCase()
  const filtered = users.filter(u => !q ||
    (u.login || '').toLowerCase().includes(q) ||
    (u.name || '').toLowerCase().includes(q) ||
    (roleLabelsMap[u.role] || '').toLowerCase().includes(q))

  const curPage = clampPage(page, filtered.length, PAGE_SIZE)
  const shown = filtered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE)
  const isMe = u => !!currentUser?.login && (u.login === currentUser.login || (phone10(u.login).length === 10 && phone10(u.login) === phone10(currentUser.login)))

  const handleSaved = updatedUser => {
    setUsers(prev => {
      const exists = prev.some(u => u.login === updatedUser.login)
      return exists ? prev.map(u => u.login === updatedUser.login ? { ...u, ...updatedUser } : u) : [updatedUser, ...prev]
    })
    setEditUser(null)
  }

  return (
    <SettingCard
      icon={Users}
      title="Пользователи сайта"
      subtitle={loading ? 'Загрузка…' : `${users.length} всего · с доступом ${withAccess}`}
      actions={<Button size="sm" variant="outline" onClick={() => setEditUser({})}><Plus className="size-3.5" /> Добавить</Button>}
      bodyClassName="p-2"
    >
      <div className="relative px-2 pt-1 pb-2">
        <Search className="pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Поиск по номеру, ФИО, роли" value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} />
      </div>

      {loading ? (
        <Spinner label="Загрузка пользователей..." />
      ) : !filtered.length ? (
        <div className="p-6 text-center text-sm text-muted-foreground">{users.length ? 'Никого не нашлось' : 'Пока никто не входил'}</div>
      ) : (
        <ul>
          {shown.map(u => {
            const roleText = u.role ? (roleLabelsMap[u.role] || u.role) : null
            const success = fmtDateTime(u.lastSuccessAt)
            // админов защищаем от других админов, разработчиков — от всех, кроме разработчиков
            const protectedAdmin = (u.role === 'admin' || u.role === 'developer') && currentUser?.role !== 'developer' && !isMe(u)
            return (
              <li key={u.login} className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl px-3 py-2.5 transition-colors hover:bg-surface-2/50', !u.hasAccess && 'opacity-75')}>
                <Avatar name={u.name || u.login} className="size-9" />
                <div className="min-w-0 basis-52">
                  <div className="truncate text-sm font-medium">{u.name || 'Без имени'}</div>
                  <div className="tabular truncate text-xs text-muted-foreground">{u.login}</div>
                </div>
                <div className="flex min-w-0 basis-44 flex-wrap items-center gap-1.5">
                  {roleText
                    ? <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-medium text-brand">{roleText}</span>
                    : <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-muted-foreground">нет доступа</span>}
                  {u.allowWithoutToken && <span className="inline-flex items-center gap-1 rounded-full bg-warning/12 px-2 py-0.5 text-xs text-warning" title="Может входить без токена WMS"><KeyRound className="size-3" /> без токена</span>}
                </div>
                <div className="min-w-0 flex-1 basis-56">
                  <ModuleChips modules={u.modules} max={3} />
                </div>
                <div className="w-32 shrink-0 text-xs text-muted-foreground" title="Последний успешный вход">
                  {success || (u.lastAttemptAt ? <span className="text-destructive">вход не удался</span> : 'не входил')}
                </div>
                <div className="flex w-[104px] shrink-0 justify-end gap-0.5">
                  {protectedAdmin ? (
                    <span className="text-xs text-muted-foreground">защищён</span>
                  ) : u.hasAccess ? (
                    <>
                      <IconAction icon={Pencil} title="Права и разделы" tone="brand" onClick={() => setEditUser(u)} />
                      <IconAction icon={Trash2} title="Забрать доступ" tone="danger" onClick={() => handleDelete(u)} />
                    </>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setEditUser(u)}>Дать доступ</Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <ListPager page={curPage} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} className="mt-1" />

      {editUser !== null && (
        <EditUserDialog
          user={editUser}
          open
          onOpenChange={open => !open && setEditUser(null)}
          roles={rolesOrBuiltin(roles)}
          emplCompanies={emplCompanies}
          onSaved={handleSaved}
        />
      )}
    </SettingCard>
  )
}
