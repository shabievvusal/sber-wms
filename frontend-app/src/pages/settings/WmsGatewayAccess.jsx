// «Доступ к шлюзу» (Настройки → Шлюз WMS, только разработчик): кому разрешено
// смотреть WMS через шлюз. Человека выбирают поиском среди зарегистрированных
// на сайте (ФИО или логин) — заявок от сотрудников нет.
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ROLE_LABELS } from './constants'
import { SettingCard } from './SettingCard'
import { Search, UserCheck } from 'lucide-react'

const fmtTime = v => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')
const STATUS = {
  approved: { label: 'Разрешён', variant: 'success' },
  revoked: { label: 'Отозван', variant: 'secondary' },
  pending: { label: 'Заявка', variant: 'warning' },
}

export function WmsGatewayAccess({ users = [], access = [], busy, onDecide, onRemove }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const byLogin = useMemo(() => new Map(users.map(u => [u.login, u])), [users])
  const nameOf = login => byLogin.get(login)?.name || login
  const accessBy = useMemo(() => new Map(access.map(a => [a.login, a])), [access])

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return []
    return users
      .filter(u => (u.name || '').toLowerCase().includes(s) || u.login.toLowerCase().includes(s))
      .slice(0, 12)
  }, [q, users])

  const grant = login => { onDecide(login, true); setQ(''); setOpen(false) }

  return (
    <SettingCard
      icon={UserCheck}
      title="Доступ к шлюзу"
      subtitle="Смотреть WMS через шлюз может только тот, кому разрешил разработчик. Найдите человека среди зарегистрированных на сайте и нажмите «Разрешить»."
    >
      <div className="space-y-3">
        <Popover open={open && matches.length > 0} onOpenChange={setOpen}>
          <PopoverAnchor asChild>
            <div className="relative w-full max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="ФИО или логин пользователя сайта"
                value={q}
                onChange={e => { setQ(e.target.value); setOpen(true) }}
                onFocus={() => setOpen(true)}
              />
            </div>
          </PopoverAnchor>
          <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-80 p-1" onOpenAutoFocus={e => e.preventDefault()}>
            {matches.map(u => {
              const a = accessBy.get(u.login)
              const allowed = a?.status === 'approved'
              return (
                <div key={u.login} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{u.name || '—'}</div>
                    <div className="truncate text-xs text-muted-foreground">{u.login}{u.role && ` · ${ROLE_LABELS[u.role] || u.role}`}</div>
                  </div>
                  {allowed
                    ? <Badge variant="success">Разрешён</Badge>
                    : <Button size="sm" disabled={busy} onClick={() => grant(u.login)}>Разрешить</Button>}
                </div>
              )
            })}
          </PopoverContent>
        </Popover>
        {q.trim() && !matches.length && <div className="text-sm text-muted-foreground">На сайте никого не нашлось</div>}

        {access.length ? (
          <div className="overflow-auto rounded-xl border border-line">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Пользователь</TableHead>
                  <TableHead>Логин</TableHead>
                  <TableHead className="text-center">Доступ</TableHead>
                  <TableHead>Изменён</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {access.map(a => {
                  const known = byLogin.has(a.login)
                  return (
                    <TableRow key={a.login}>
                      <TableCell>{known ? nameOf(a.login) : <span className="text-muted-foreground">нет на сайте</span>}</TableCell>
                      <TableCell className="font-mono text-xs">{a.login}</TableCell>
                      <TableCell className="text-center"><Badge variant={STATUS[a.status]?.variant || 'secondary'}>{STATUS[a.status]?.label || a.status}</Badge></TableCell>
                      <TableCell className="text-xs">{a.decidedAt ? `${fmtTime(a.decidedAt)} · ${nameOf(a.decidedBy)}` : '—'}</TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          {a.status !== 'approved' && known && <Button size="sm" disabled={busy} onClick={() => onDecide(a.login, true)}>Разрешить</Button>}
                          {a.status === 'approved' && <Button size="sm" variant="outline" disabled={busy} onClick={() => onDecide(a.login, false)}>Отозвать</Button>}
                          {a.status !== 'approved' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRemove(a.login)}>Убрать</Button>}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">Доступ к шлюзу пока никому не выдан</div>
        )}
      </div>
    </SettingCard>
  )
}
