// Настройки → «Шлюз WMS» (только разработчик).
// 1) Шлюзы склада: шлюзом сам работает каждый открытый сайт со своей живой
//    сессией WMS (lib/wms/gatewayHost.js) — здесь видно, кто сейчас в сети.
//    Первая версия: шлюз запускал разработчик кнопкой на одном ПК.
// 2) Кому разрешён шлюз: заявки сотрудников, одобрение и отзыв доступа.
// 3) Журнал запросов через шлюз (кто спросил и чей шлюз выполнил).
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiHeaders } from '@/lib/api'
import { useGatewayHost } from '@/lib/wms/gatewayHost'
import { useAuth } from '@/context/AuthContext'
import { useWarehouse, shortWarehouseName } from '@/lib/warehouse'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SettingCard } from './SettingCard'
import { Network, UserCheck } from 'lucide-react'

// ─── API ──────────────────────────────────────────────────────────────────

async function call(url, init = {}) {
  const r = await fetch(url, { credentials: 'include', ...init, headers: apiHeaders({ 'Content-Type': 'application/json', ...(init.headers || {}) }) })
  const d = await r.json().catch(() => null)
  if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`)
  return d
}

const fmtTime = v => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—')
const STATUS = {
  pending: { label: 'Заявка', variant: 'warning' },
  approved: { label: 'Разрешён', variant: 'success' },
  revoked: { label: 'Отозван', variant: 'secondary' },
}

export function WmsGatewayCard() {
  const { user } = useAuth()
  const { list } = useWarehouse(user)
  const h = useGatewayHost()
  const [admin, setAdmin] = useState(null)
  const [login, setLogin] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => call('/api/wms-gateway/admin').then(setAdmin).catch(err => toast.error(err.message))
  useEffect(() => {
    load()
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [])

  const decide = async (who, approve) => {
    setBusy(true)
    try {
      await call('/api/wms-gateway/admin/decide', { method: 'POST', body: JSON.stringify({ login: who, approve }) })
      toast.success(approve ? 'Доступ к шлюзу выдан' : 'Доступ к шлюзу отозван')
      setLogin('')
      await load()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  const whName = id => shortWarehouseName(list.find(w => w.id === id)?.name || '') || id
  const gw = admin?.gateway
  const pending = (admin?.access || []).filter(a => a.status === 'pending').length

  return (
    <div className="space-y-4">
      <SettingCard
        icon={Network}
        title="Шлюзы склада"
        subtitle="Шлюзом сам работает каждый открытый сайт, где у человека своя живая сессия WMS: он выполняет запросы сотрудников без доступа своей сессией. Только просмотр: всё, что меняет данные в WMS, сервер не пропускает."
      >
        <div className="space-y-3 text-sm">
          <div>
            Склад, выбранный на сайте: {gw?.online ? <b className="text-success">шлюзов в сети — {gw.hostsOnline}</b> : <b>ни одного шлюза в сети</b>}
            {gw?.queue > 0 && <> · в очереди {gw.queue}</>}
            {gw && <> · выполнено {gw.done}{gw.failed > 0 && <>, с ошибкой {gw.failed}</>} (с перезапуска сервера)</>}
          </div>
          {gw?.hosts?.length > 0 && (
            <div className="overflow-auto rounded-xl border border-line">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Шлюз (учётка сайта)</TableHead>
                    <TableHead className="text-center">Состояние</TableHead>
                    <TableHead>Последний раз</TableHead>
                    <TableHead className="text-center">Выполнено</TableHead>
                    <TableHead className="text-center">С ошибкой</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {gw.hosts.map(x => (
                    <TableRow key={x.login}>
                      <TableCell className="font-mono text-xs">{x.login}</TableCell>
                      <TableCell className="text-center"><Badge variant={x.online ? 'success' : 'secondary'}>{x.online ? 'в сети' : 'нет'}</Badge></TableCell>
                      <TableCell className="text-xs">{fmtTime(x.lastSeen)}</TableCell>
                      <TableCell className="text-center">{x.done}</TableCell>
                      <TableCell className="text-center">{x.failed}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div className="text-muted-foreground">
            Этот компьютер: {h.running ? <b className="text-success">работает шлюзом</b> : 'не шлюз (нет своей сессии WMS или шлюзом работает другая вкладка)'}
            {h.running && h.wh && <> · склад в WMS: <b>{whName(h.wh)}</b> · выполнено {h.done}{h.failed > 0 && <>, с ошибкой {h.failed}</>}</>}
          </div>
          {h.error && <div className="text-destructive">Ошибка шлюза этого компьютера: {h.error} — повторю через 5 с</div>}
        </div>
      </SettingCard>

      <SettingCard
        icon={UserCheck}
        accent={pending > 0}
        title="Доступ к шлюзу"
        subtitle="Пользоваться шлюзом может только тот, кому разрешил разработчик. Сотрудник без сессии WMS оставляет заявку из бокового меню («Доступ к WMS через шлюз»)."
      >
        <div className="space-y-3">
          <form className="flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); if (login.trim()) decide(login.trim(), true) }}>
            <Input className="h-8 w-64" placeholder="Логин пользователя сайта" value={login} onChange={e => setLogin(e.target.value)} />
            <Button size="sm" type="submit" disabled={busy || !login.trim()}>Разрешить</Button>
          </form>
          {admin?.access?.length ? (
            <div className="overflow-auto rounded-xl border border-line">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Пользователь</TableHead>
                    <TableHead>Логин</TableHead>
                    <TableHead className="text-center">Статус</TableHead>
                    <TableHead>Заявка</TableHead>
                    <TableHead>Решение</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {admin.access.map(a => (
                    <TableRow key={a.login}>
                      <TableCell>{a.name || '—'}</TableCell>
                      <TableCell className="font-mono text-xs">{a.login}</TableCell>
                      <TableCell className="text-center"><Badge variant={STATUS[a.status]?.variant || 'secondary'}>{STATUS[a.status]?.label || a.status}</Badge></TableCell>
                      <TableCell className="text-xs">{fmtTime(a.requestedAt)}</TableCell>
                      <TableCell className="text-xs">{a.decidedAt ? `${fmtTime(a.decidedAt)} · ${a.decidedBy}` : '—'}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {a.status !== 'approved' && <Button size="sm" disabled={busy} onClick={() => decide(a.login, true)}>Разрешить</Button>}
                          {a.status !== 'revoked' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide(a.login, false)}>{a.status === 'pending' ? 'Отклонить' : 'Отозвать'}</Button>}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">Заявок пока нет</div>
          )}
        </div>
      </SettingCard>

      <SettingCard icon={Network} title="Журнал шлюза" subtitle="Последние 300 запросов через шлюз: кто, когда и что смотрел в WMS и чьей сессией WMS выполнен запрос. Хранится 90 дней.">
        {admin?.log?.length ? (
          <div className="max-h-[480px] overflow-auto rounded-xl border border-line">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Время</TableHead>
                  <TableHead>Пользователь</TableHead>
                  <TableHead>Склад</TableHead>
                  <TableHead>Чей шлюз</TableHead>
                  <TableHead>Запрос</TableHead>
                  <TableHead className="text-center">Ответ</TableHead>
                  <TableHead className="text-center">Время, мс</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {admin.log.map((l, i) => (
                  <TableRow key={i}>
                    <TableCell className="whitespace-nowrap text-xs">{fmtTime(l.at)}</TableCell>
                    <TableCell className="text-xs">{admin.access.find(a => a.login === l.login)?.name || l.login}</TableCell>
                    <TableCell className="text-xs">{whName(l.warehouseId)}</TableCell>
                    <TableCell className="font-mono text-xs">{l.hostLogin || '—'}</TableCell>
                    <TableCell className="text-xs">{l.method} {l.path}</TableCell>
                    <TableCell className={`text-center text-xs ${l.status >= 300 ? 'text-destructive' : ''}`}>{l.status}</TableCell>
                    <TableCell className="text-center text-xs">{l.ms}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">Запросов через шлюз ещё не было</div>
        )}
      </SettingCard>
    </div>
  )
}
