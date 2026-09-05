import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '@/lib/api'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { Search } from 'lucide-react'
import { fmtDate } from './format'

const MODE_BY_OP = { ship: 'unshipped', receive: 'pending', eo_list: '' }

// «Список ЕО» — единственный режим без `mode`: у отгрузки и приёмки список
// сам собой сужается до незакрытых маршрутов, а здесь фильтра нет вообще, и
// раньше отдавались ВСЕ маршруты за всю историю (пользователь 2026-09-06:
// «много маршрутов с других дат»). Окно — те же сегодня + вчера, что
// обновляет фон (lib/eoAutoRefresh.jsx), то есть в списке ровно те маршруты,
// у которых ЕО актуальные. При текстовом поиске окно снимается — старый
// маршрут по-прежнему находится по номеру/водителю/адресу.
const EO_LIST_DAYS = 2

export function StepSearch({ opType, onSelect }) {
  const [query, setQuery] = useState('')
  const [routes, setRoutes] = useState(null)
  const [error, setError] = useState('')
  const timer = useRef(null)

  const doSearch = useCallback(async q => {
    const mode = MODE_BY_OP[opType] || ''
    const days = opType === 'eo_list' && !q ? EO_LIST_DAYS : undefined
    try {
      const list = await api.searchRkRoutes({ mode, q, days })
      setRoutes(list)
      setError('')
    } catch (err) {
      setRoutes([])
      setError(err.message || 'Не удалось загрузить маршруты')
    }
  }, [opType])

  useEffect(() => { doSearch('') }, [doSearch])

  const onQueryChange = e => {
    const val = e.target.value
    setQuery(val)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => doSearch(val.trim()), 300)
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-8" placeholder="Водитель, маршрут, адрес ЦФЗ..." value={query} onChange={onQueryChange} autoFocus />
      </div>

      <div className="space-y-2">
        {routes === null && <Spinner label="Загрузка..." />}
        {error && <div className="text-sm text-destructive">{error}</div>}
        {routes !== null && !error && routes.length === 0 && (
          <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">Маршруты не найдены</div>
        )}
        {opType === 'eo_list' && !query.trim() && routes !== null && !error && (
          <div className="text-xs text-muted-foreground">Показаны маршруты за сегодня и вчера — остальные найдутся через поиск</div>
        )}
        {routes && routes.map((r, i) => {
          const cfz = r.cfzAddresses || []
          const cfzStr = cfz.slice(0, 3).map(a => a.address).join(', ') + (cfz.length > 3 ? '…' : '')
          const done = opType === 'ship' && r.shipment ? (r.shipment.items || []).length : null
          return (
            <button
              key={r.routeId || i}
              className="block w-full space-y-1 rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary hover:bg-accent"
              onClick={() => onSelect(r)}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{fmtDate(r.date)}</span>
                <span className="font-semibold">{r.routeNumber || '—'}</span>
                {r.vehicle && <span className="text-xs text-muted-foreground">{r.vehicle.number || ''}</span>}
              </div>
              {r.driver && <div className="text-sm">{r.driver.name || ''}</div>}
              {cfzStr && <div className="text-xs text-muted-foreground">{cfzStr}</div>}
              {done !== null && <Badge variant="warning">Заполнено {done} из {cfz.length} адресов</Badge>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
