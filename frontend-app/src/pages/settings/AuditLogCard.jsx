import { Fragment, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { DateRangePicker } from '@/components/ui/date-picker'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { History, RefreshCw, ChevronRight } from 'lucide-react'
import { SettingCard } from './SettingCard'

// Журнал действий на сайте: кто, когда и что изменил (пишет dotnet, AuditLog.cs).
// Записи старше года удаляются. Видит только разработчик.

const mskDate = (shiftDays = 0) => new Date(Date.now() + 3 * 3600_000 + shiftDays * 86400_000).toISOString().slice(0, 10)
const fmtAt = iso => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })

function Result({ status, action }) {
  if (status < 400) return <Badge variant="success">Выполнено</Badge>
  if (action === 'Вход на сайт') return <Badge variant="warning">Неверный вход</Badge>
  if (status === 401 || status === 403) return <Badge variant="warning">Нет прав · {status}</Badge>
  if (status === 404) return <Badge variant="secondary">Не найдено</Badge>
  return <Badge variant="destructive">Ошибка · {status}</Badge>
}

// подписи частых полей запроса; остальные — как есть
const FIELD_LABELS = {
  login: 'Логин', name: 'Имя', fio: 'ФИО', role: 'Роль', modules: 'Разделы', actions: 'Действия', password: 'Пароль',
  company: 'Компания', executorId: 'ID сотрудника', phone: 'Телефон', date: 'Дата', dateFrom: 'С', dateTo: 'По',
  shift: 'Смена', shiftKey: 'Смена', present: 'Присутствуют', status: 'Статус', id: 'ID', routeId: 'Маршрут',
  tsd: 'ТСД', cell: 'Ячейка', barcode: 'ШК', hu: 'ЕО', title: 'Название', label: 'Название', key: 'Ключ',
  files: 'Файлы', people: 'Люди', ids: 'Записи', items: 'Записи', zoneName: 'Зона', address: 'Адрес',
}
const SHIFT_VALUES = { day: 'дневная', night: 'ночная' }

// подробности: данные запроса строками «поле: значение»
function Details({ item }) {
  const rows = []
  const add = (k, v) => rows.push([FIELD_LABELS[k] || k, k === 'shift' && SHIFT_VALUES[v] ? SHIFT_VALUES[v] : typeof v === 'string' ? v : JSON.stringify(v)])
  for (const [k, v] of Object.entries(item.details || {})) {
    if (k === 'body' && v && typeof v === 'object' && !Array.isArray(v)) for (const [bk, bv] of Object.entries(v)) add(bk, bv)
    else add(k, v)
  }
  return (
    <div className="space-y-2 text-sm">
      <div className="text-muted-foreground">
        {item.method} {item.path}{item.ip ? ` · IP ${item.ip}` : ''}{item.role ? ` · роль ${item.role}` : ''}
      </div>
      {rows.length > 0 && (
        <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          {rows.map(([k, v], i) => (
            <Fragment key={i}>
              <span className="text-muted-foreground">{k}</span>
              <span className="break-all font-mono text-xs leading-5">{v}</span>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

export function AuditLogCard() {
  const [range, setRange] = useState({ from: mskDate(-7), to: mskDate() })
  const [login, setLogin] = useState('')
  const [query, setQuery] = useState('')
  const [q, setQ] = useState('')
  const [data, setData] = useState(null) // { items, hasMore, users }
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(null)
  const reqId = useRef(0)

  // поиск — после паузы в наборе
  useEffect(() => { const t = setTimeout(() => setQ(query.trim()), 400); return () => clearTimeout(t) }, [query])

  const load = async (beforeId = null) => {
    if (!range.from || !range.to) return
    const id = ++reqId.current
    setLoading(true)
    try {
      const res = await api.getAuditLog({ from: range.from, to: range.to, login, q, beforeId })
      if (id !== reqId.current) return
      setData(prev => (beforeId && prev ? { ...res, items: [...prev.items, ...res.items] } : res))
    } catch (err) {
      if (id === reqId.current) toast.error(err.message)
    } finally {
      if (id === reqId.current) setLoading(false)
    }
  }
  useEffect(() => { setOpen(null); load() }, [range.from, range.to, login, q]) // eslint-disable-line react-hooks/exhaustive-deps

  const items = data?.items || []

  return (
    <SettingCard
      icon={History}
      title="Журнал действий"
      subtitle="Кто и что изменил на сайте: вход, пользователи и права, сотрудники, ТСД, отгрузка, жалобы, удаление данных. Хранится год."
      actions={<Button variant="secondary" size="sm" onClick={() => load()} disabled={loading}><RefreshCw className="size-4" /> Обновить</Button>}
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <DateRangePicker className="h-9 w-60" from={range.from} to={range.to} onChange={({ from, to }) => setRange({ from, to })} />
        <Select className="h-9 min-w-52" value={login} onChange={e => setLogin(e.target.value)}>
          <option value="">Все пользователи</option>
          {(data?.users || []).map(u => <option key={u.login} value={u.login}>{u.name ? `${u.name} (${u.login})` : u.login}</option>)}
        </Select>
        <Input className="h-9 w-64" placeholder="Поиск: действие, логин, данные" value={query} onChange={e => setQuery(e.target.value)} />
        {loading && <Spinner className="size-4" />}
      </div>

      {data && !items.length ? (
        <div className="py-8 text-center text-sm text-muted-foreground">За выбранный период действий нет</div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead className="text-center">Время</TableHead>
                <TableHead>Кто</TableHead>
                <TableHead>Действие</TableHead>
                <TableHead>Что именно</TableHead>
                <TableHead className="text-center">Результат</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map(it => (
                <Fragment key={it.id}>
                  <TableRow className="cursor-pointer" onClick={() => setOpen(open === it.id ? null : it.id)}>
                    <TableCell><ChevronRight className={`size-4 text-muted-foreground transition-transform ${open === it.id ? 'rotate-90' : ''}`} /></TableCell>
                    <TableCell className="whitespace-nowrap text-center tabular-nums">{fmtAt(it.at)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {it.name || it.login || <span className="text-muted-foreground">—</span>}
                      {it.name && it.login && <div className="text-xs text-muted-foreground">{it.login}</div>}
                    </TableCell>
                    <TableCell className="font-medium">{it.action}</TableCell>
                    <TableCell className="max-w-md truncate text-muted-foreground" title={it.summary}>{it.summary}</TableCell>
                    <TableCell className="text-center"><Result status={it.status} action={it.action} /></TableCell>
                  </TableRow>
                  {open === it.id && (
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell />
                      <TableCell colSpan={5}><Details item={it} /></TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {data?.hasMore && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={() => load(items[items.length - 1]?.id)} disabled={loading}>Показать ещё</Button>
        </div>
      )}
    </SettingCard>
  )
}
