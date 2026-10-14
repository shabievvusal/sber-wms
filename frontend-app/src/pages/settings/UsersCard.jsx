import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { SettingCard } from './SettingCard'
import { EditUserDialog } from './EditUserDialog'
import { UsersBulkBar } from './UsersBulk'
import { rolesToLabelMap, rolesOrBuiltin } from './constants'
import { Avatar, IconAction, ListPager, ModuleChips, clampPage } from './ui'
import { KeyRound, Pencil, Plus, Search, Trash2, Users } from 'lucide-react'
import { ONLINE_WINDOW_MS } from '@/lib/presence'

const PAGE_SIZE = 20
const phone10 = v => String(v || '').replace(/\D/g, '').slice(-10)

// «в сети» / «5 мин назад» / «сегодня в 14:20» / «вчера в 09:05» / «12.10.2026 в 18:40»
function fmtSeen(iso, now) {
  if (!iso) return null
  const t = new Date(iso).getTime()
  const diff = now - t
  if (diff < ONLINE_WINDOW_MS) return { online: true, text: 'в сети' }
  if (diff < 60 * 60_000) return { online: false, text: `${Math.max(1, Math.round(diff / 60_000))} мин назад` }
  const d = new Date(t)
  const p = n => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  const day0 = new Date(now); day0.setHours(0, 0, 0, 0)
  if (t >= day0.getTime()) return { online: false, text: `сегодня в ${hm}` }
  if (t >= day0.getTime() - 86_400_000) return { online: false, text: `вчера в ${hm}` }
  return { online: false, text: `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} в ${hm}` }
}

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
  // выбранные для массовых действий (логины)
  const [selected, setSelected] = useState(() => new Set())

  const [now, setNow] = useState(() => Date.now())

  const load = () => {
    setLoading(true)
    return withMinDuration(async () => {
      try { setUsers(await api.getVsAdminUsers()) }
      catch { setUsers([]) }
    }).finally(() => { setLoading(false); setNow(Date.now()) })
  }

  useEffect(() => { load() }, [])

  const reloadSilently = async () => {
    try { setUsers(await api.getVsAdminUsers()) } catch { /* оставим как есть */ }
    setNow(Date.now())
  }

  // «Был в сети» — раз в минуту тихо обновляем список (без спиннера),
  // пока вкладка видна, чтобы точки «в сети» не устаревали.
  useEffect(() => {
    const t = setInterval(async () => {
      if (document.visibilityState !== 'visible') return
      try { setUsers(await api.getVsAdminUsers()) } catch { /* следующая попытка через минуту */ }
      setNow(Date.now())
    }, 60_000)
    return () => clearInterval(t)
  }, [])

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
  const seenMs = u => (u.lastSeenAt ? new Date(u.lastSeenAt).getTime() : 0)
  const onlineCount = users.filter(u => now - seenMs(u) < ONLINE_WINDOW_MS).length

  const q = search.trim().toLowerCase()
  // сначала те, кто в сети / был недавно, дальше по алфавиту
  const filtered = users
    .filter(u => !q ||
      (u.login || '').toLowerCase().includes(q) ||
      (u.name || '').toLowerCase().includes(q) ||
      (roleLabelsMap[u.role] || '').toLowerCase().includes(q))
    .sort((a, b) => seenMs(b) - seenMs(a) || String(a.name || a.login).localeCompare(String(b.name || b.login), 'ru'))

  const curPage = clampPage(page, filtered.length, PAGE_SIZE)
  const shown = filtered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE)
  const isMe = u => !!currentUser?.login && (u.login === currentUser.login || (phone10(u.login).length === 10 && phone10(u.login) === phone10(currentUser.login)))
  // админов защищаем от других админов, разработчиков — от всех, кроме разработчиков
  const isProtected = u => (u.role === 'admin' || u.role === 'developer') && currentUser?.role !== 'developer' && !isMe(u)
  // массово можно менять только тех, у кого есть доступ, кроме защищённых и себя
  const canBulk = u => u.hasAccess && !isProtected(u) && !isMe(u)

  const selectableShown = shown.filter(canBulk)
  const selectableAll = filtered.filter(canBulk)
  const allShownSelected = selectableShown.length > 0 && selectableShown.every(u => selected.has(u.login))
  const someShownSelected = selectableShown.some(u => selected.has(u.login))
  const selectedUsers = useMemo(() => users.filter(u => selected.has(u.login) && canBulk(u)), [users, selected]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleOne = login => setSelected(prev => {
    const next = new Set(prev)
    next.has(login) ? next.delete(login) : next.add(login)
    return next
  })
  const toggleShown = () => setSelected(prev => {
    const next = new Set(prev)
    if (allShownSelected) selectableShown.forEach(u => next.delete(u.login))
    else selectableShown.forEach(u => next.add(u.login))
    return next
  })

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
      subtitle={loading ? 'Загрузка…' : `${users.length} всего · с доступом ${withAccess} · в сети ${onlineCount}`}
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
        <>
        {selectableAll.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 px-3 pb-1 text-xs text-muted-foreground">
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox checked={allShownSelected ? true : someShownSelected ? 'indeterminate' : false} onCheckedChange={toggleShown} />
              выбрать на странице
            </label>
            {selectableAll.length > selectableShown.length && (
              <button type="button" className="font-medium text-brand hover:underline" onClick={() => setSelected(new Set(selectableAll.map(u => u.login)))}>
                выбрать всех найденных ({selectableAll.length})
              </button>
            )}
            {selected.size > 0 && (
              <button type="button" className="hover:text-foreground hover:underline" onClick={() => setSelected(new Set())}>снять выделение</button>
            )}
          </div>
        )}
        <ul>
          {shown.map(u => {
            const roleText = u.role ? (roleLabelsMap[u.role] || u.role) : null
            const seen = fmtSeen(u.lastSeenAt, now)
            const lastLogin = fmtDateTime(u.lastSuccessAt)
            const protectedAdmin = isProtected(u)
            const checked = selected.has(u.login)
            return (
              <li key={u.login} className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl px-3 py-2.5 transition-colors hover:bg-surface-2/50', !u.hasAccess && 'opacity-75', checked && 'bg-brand-soft/50 hover:bg-brand-soft/60')}>
                <span className="grid w-4 shrink-0 place-items-center">
                  {canBulk(u) && <Checkbox checked={checked} onCheckedChange={() => toggleOne(u.login)} aria-label={`Выбрать ${u.name || u.login}`} />}
                </span>
                <span className="relative shrink-0">
                  <Avatar name={u.name || u.login} className="size-9" />
                  {seen?.online && <span className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full bg-good ring-2 ring-card" title="В сети" />}
                </span>
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
                <div
                  className="w-36 shrink-0 text-xs"
                  title={[seen && `Был в сети: ${seen.text}`, lastLogin ? `Последний вход: ${lastLogin}` : null].filter(Boolean).join('\n') || undefined}
                >
                  {seen?.online ? (
                    <span className="inline-flex items-center gap-1.5 font-medium text-good">
                      <span className="relative flex size-2">
                        <span className="pulse-ring absolute inline-flex size-full rounded-full bg-good" />
                        <span className="relative inline-flex size-2 rounded-full bg-good" />
                      </span>
                      в сети
                    </span>
                  ) : seen ? (
                    <span className="text-muted-foreground">был {seen.text}</span>
                  ) : lastLogin ? (
                    <span className="text-muted-foreground">вход {lastLogin}</span>
                  ) : u.lastAttemptAt ? (
                    <span className="text-destructive">вход не удался</span>
                  ) : (
                    <span className="text-muted-foreground">не заходил</span>
                  )}
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
        </>
      )}
      <ListPager page={curPage} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} className="mt-1" />

      {selectedUsers.length > 0 && (
        <UsersBulkBar
          users={selectedUsers}
          roles={rolesOrBuiltin(roles)}
          onClear={() => setSelected(new Set())}
          onDone={() => { setSelected(new Set()); reloadSilently() }}
        />
      )}

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
