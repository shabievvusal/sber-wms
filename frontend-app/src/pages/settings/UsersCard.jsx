import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Spinner } from '@/components/ui/spinner'
import { SettingCard } from './SettingCard'
import { EditUserDialog } from './EditUserDialog'
import { VS_MODULE_LABELS, rolesToLabelMap, rolesOrBuiltin } from './constants'
import { User } from 'lucide-react'

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

  const load = () => {
    setLoading(true)
    return withMinDuration(async () => {
      try { setUsers(await api.getVsAdminUsers()) }
      catch { setUsers([]) }
    }).finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const handleDelete = async login => {
    if (!confirm(`Удалить доступ для ${login}?`)) return
    try {
      await api.deleteVsAdminUser(login)
      setUsers(prev => prev.filter(u => u.login !== login))
      toast.success('Доступ удалён')
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    }
  }

  const roleLabelsMap = rolesToLabelMap(rolesOrBuiltin(roles))
  const successful = users.filter(u => u.lastSuccessAt).length

  const q = search.trim().toLowerCase()
  const filtered = users.filter(u => !q ||
    (u.login || '').toLowerCase().includes(q) ||
    (u.name || '').toLowerCase().includes(q) ||
    (roleLabelsMap[u.role] || '').toLowerCase().includes(q))

  const handleSaved = updatedUser => {
    setUsers(prev => {
      const exists = prev.some(u => u.login === updatedUser.login)
      return exists ? prev.map(u => u.login === updatedUser.login ? { ...u, ...updatedUser } : u) : [updatedUser, ...prev]
    })
    setEditUser(null)
  }

  return (
    <SettingCard
      icon={User}
      title="Пользователи"
      subtitle={`Всего: ${users.length}, успешных входов: ${successful}`}
      actions={<Button size="sm" onClick={() => setEditUser({})}>+ Добавить</Button>}
    >
      <Input className="mb-3" placeholder="Поиск по логину, ФИО, роли..." value={search} onChange={e => setSearch(e.target.value)} />
      {loading ? (
        <Spinner label="Загрузка пользователей..." />
      ) : !filtered.length ? (
        <div className="rounded-md border p-6 text-center text-muted-foreground">{users.length ? 'Ничего не найдено' : 'Нет записей о входах'}</div>
      ) : (
        <>
          {/* Мобильные карточки — до md (768px) */}
          <div className="divide-y rounded-md border md:hidden">
            {filtered.map(u => {
              let roleText = u.role ? (roleLabelsMap[u.role] || u.role) : '—'
              if (u.allowWithoutToken) roleText += ' (без токена)'
              const modulesText = u.modules?.length ? u.modules.map(m => VS_MODULE_LABELS[m] || m).join(', ') : '—'
              const successText = fmtDateTime(u.lastSuccessAt) || (u.lastAttemptAt ? 'Нет (ошибка)' : '—')
              const protectedAdmin = u.role === 'admin' && currentUser?.role !== 'developer' && currentUser?.login !== u.login
              return (
                <div key={u.login} className="space-y-1.5 p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{u.login}</span>
                    <span className="text-xs text-muted-foreground">{roleText}</span>
                  </div>
                  <div className="text-muted-foreground">{u.name || '—'}</div>
                  <div className="truncate text-xs text-muted-foreground" title={modulesText}>Модули: {modulesText}</div>
                  <div className="text-xs text-muted-foreground">Успешный вход: {successText}</div>
                  <div className="pt-1">
                    {protectedAdmin ? (
                      <span className="text-xs text-muted-foreground">Администратор</span>
                    ) : u.hasAccess ? (
                      <div className="flex gap-1.5">
                        <Button size="sm" variant="outline" onClick={() => setEditUser(u)}>Изменить</Button>
                        <Button size="sm" variant="destructive" onClick={() => handleDelete(u.login)}>Удалить</Button>
                      </div>
                    ) : (
                      <Button size="sm" onClick={() => setEditUser(u)}>Дать доступ</Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Десктопная таблица — от md и шире */}
          <div className="hidden overflow-x-auto rounded-md border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Логин</TableHead>
                  <TableHead>ФИО</TableHead>
                  <TableHead>Роль</TableHead>
                  <TableHead>Модули</TableHead>
                  <TableHead>Успешный вход</TableHead>
                  <TableHead className="text-right">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(u => {
                  let roleText = u.role ? (roleLabelsMap[u.role] || u.role) : '—'
                  if (u.allowWithoutToken) roleText += ' (без токена)'
                  const modulesText = u.modules?.length ? u.modules.map(m => VS_MODULE_LABELS[m] || m).join(', ') : '—'
                  const successText = fmtDateTime(u.lastSuccessAt) || (u.lastAttemptAt ? 'Нет (ошибка)' : '—')
                  const protectedAdmin = u.role === 'admin' && currentUser?.role !== 'developer' && currentUser?.login !== u.login
                  return (
                    <TableRow key={u.login}>
                      <TableCell className="font-medium">{u.login}</TableCell>
                      <TableCell className="text-muted-foreground">{u.name || '—'}</TableCell>
                      <TableCell>{roleText}</TableCell>
                      <TableCell className="max-w-56 truncate text-xs text-muted-foreground" title={modulesText}>{modulesText}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{successText}</TableCell>
                      <TableCell className="text-right">
                        {protectedAdmin ? (
                          <span className="text-xs text-muted-foreground">Администратор</span>
                        ) : u.hasAccess ? (
                          <div className="flex justify-end gap-1.5">
                            <Button size="sm" variant="outline" onClick={() => setEditUser(u)}>Изменить</Button>
                            <Button size="sm" variant="destructive" onClick={() => handleDelete(u.login)}>Удалить</Button>
                          </div>
                        ) : (
                          <Button size="sm" onClick={() => setEditUser(u)}>Дать доступ</Button>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </>
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
