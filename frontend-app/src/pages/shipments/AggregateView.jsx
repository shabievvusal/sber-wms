import { useState, Fragment } from 'react'
import { cn } from '@/lib/utils'
import { toggleSortState } from '@/lib/sort'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { SortableHead } from '@/components/ui/sortable-head'
import { TopLoadingBar } from '@/components/ui/top-loading-bar'
import { ChevronDown } from 'lucide-react'
import { metricDiff, metricAggDiff } from './metrics'

function aggSortValue(row, key, keyField, metric) {
  switch (key) {
    case 'key': return String(row[keyField] || '')
    case 'shipped': return row[metric.aggShippedField] ?? 0
    case 'received': return row[metric.aggReceivedField] ?? 0
    case 'diff': return metricAggDiff(row, metric) ?? 0
    default: return row[key] ?? 0 // routeCount, rokhlyaDebt
  }
}

function sortAggRows(rows, sort, keyField, metric) {
  if (!sort.key || !sort.dir) return rows
  return [...rows].sort((a, b) => {
    const av = aggSortValue(a, sort.key, keyField, metric)
    const bv = aggSortValue(b, sort.key, keyField, metric)
    if (typeof av === 'string') return sort.dir === 'desc' ? bv.localeCompare(av, 'ru') : av.localeCompare(bv, 'ru')
    return sort.dir === 'desc' ? bv - av : av - bv
  })
}

function fmtDate(d) {
  if (!d) return '—'
  const [y, m, day] = d.slice(0, 10).split('-')
  return `${day}.${m}.${y}`
}

function DiffBadge({ diff }) {
  if (diff == null) return <span className="text-muted-foreground">—</span>
  if (diff === 0) return <span className="text-muted-foreground">0</span>
  return (
    <span className={cn('font-medium tabular-nums', diff > 0 ? 'text-success' : 'text-destructive')}>
      {diff > 0 ? `+${diff}` : diff}
    </span>
  )
}

// Мобильная карточка — та же свёрнутая/развёрнутая логика, что и в строке
// десктопной таблицы ниже, просто вертикальная раскладка вместо строки с 5-6
// колонками. Брейкпоинт `md` (768px) — как и у основного списка маршрутов
// (см. MobileRouteCard в ShipmentsPage.jsx) и как в оригинале.
function MobileAggregateCard({ row, isOpen, onToggle, keyField, metric, showRokhlya }) {
  const key = row[keyField]
  const debtRoute = showRokhlya && row.rokhlyaDebt
    ? (row.routes || []).filter(r => r.rokhlyaDebt > 0).sort((a, b) => (a.date || '').localeCompare(b.date || ''))[0] || null
    : null

  return (
    <div className="p-3">
      <div className="flex cursor-pointer items-start justify-between gap-2" onClick={onToggle}>
        <div className="min-w-0">
          <div className="truncate font-medium">{key}</div>
          <div className="text-xs text-muted-foreground">{row.routeCount} марш.</div>
        </div>
        <ChevronDown className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span><span className="text-muted-foreground">{metric.label} отгр. </span><span className="tabular-nums font-medium">{row[metric.aggShippedField] || 0}</span></span>
        <span><span className="text-muted-foreground">принято </span><span className="tabular-nums font-medium">{row[metric.aggReceivedField] || 0}</span></span>
        <DiffBadge diff={metricAggDiff(row, metric)} />
        {showRokhlya && (
          <span className="flex flex-col">
            {row.rokhlyaDebt ? <Badge variant="warning" className="w-fit">{row.rokhlyaDebt}</Badge> : <span className="text-muted-foreground">—</span>}
            {debtRoute && <span className="text-xs text-muted-foreground">с {fmtDate(debtRoute.date)} · {debtRoute.routeNumber}</span>}
          </span>
        )}
      </div>

      {isOpen && (
        <div className="mt-3 space-y-1 border-t pt-2">
          {!row.routes?.length ? (
            <div className="text-sm text-muted-foreground">Маршруты не найдены</div>
          ) : row.routes.map(r => (
            <div key={r.routeId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 rounded-md bg-muted/30 px-2 py-1.5 text-sm">
              <span className="font-medium">{r.routeNumber || '—'}</span>
              <span className="text-muted-foreground">{fmtDate(r.date)}</span>
              {keyField === 'address' && <span className="text-muted-foreground">{r.driver?.name || '—'}</span>}
              <span className="tabular-nums">↗ {r[metric.shippedField] ?? '—'}</span>
              <span className="tabular-nums">↙ {r[metric.receivedField] ?? '—'}</span>
              <DiffBadge diff={metricDiff(r, metric)} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Общая свёрнутая/развёрнутая таблица для вкладок «По водителям» и «По ЦФЗ» —
 * формы ответа очень похожи (см. rkStorage.getByDriver/getByCfz в оригинале),
 * поэтому один компонент вместо двух почти одинаковых.
 */
export default function AggregateView({ rows, loading, error, keyField, keyLabel, showRokhlya, metric, emptyLabel }) {
  const [expanded, setExpanded] = useState(() => new Set())
  const [sort, setSort] = useState({ key: null, dir: null })
  const toggle = key => setExpanded(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })
  const toggleSort = key => setSort(s => toggleSortState(s, key))

  // Спиннер — только пока данных вообще ещё не было. При повторной загрузке
  // (переключение вкладки туда-обратно, поиск) старая таблица остаётся на
  // месте как есть, сверху — тонкая полоса загрузки (TopLoadingBar) вместо
  // мигания содержимым каждый раз.
  if (loading && !rows.length) {
    return (
      <div className="rounded-lg border bg-card">
        <Spinner label="Загрузка..." />
      </div>
    )
  }
  if (error) return <div className="rounded-lg border bg-card p-6 text-sm text-destructive">{error}</div>
  if (!rows.length) return <div className="rounded-lg border bg-card p-10 text-center text-sm text-muted-foreground">{emptyLabel}</div>

  const sortedRows = sortAggRows(rows, sort, keyField, metric)

  return (
    <div className="relative rounded-lg border bg-card">
      <TopLoadingBar active={loading} />

      {/* Мобильные карточки — до md (768px) */}
      <div className="divide-y md:hidden">
        {sortedRows.map(row => (
          <MobileAggregateCard
            key={row[keyField]}
            row={row}
            isOpen={expanded.has(row[keyField])}
            onToggle={() => toggle(row[keyField])}
            keyField={keyField}
            metric={metric}
            showRokhlya={showRokhlya}
          />
        ))}
      </div>

      {/* Десктопная таблица — от md и шире */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead label={keyLabel} sortKey="key" sort={sort} onSort={toggleSort} />
              <SortableHead label="Маршрутов" sortKey="routeCount" sort={sort} onSort={toggleSort} />
              <SortableHead label={`${metric.label} отгружено`} sortKey="shipped" sort={sort} onSort={toggleSort} />
              <SortableHead label={`${metric.label} принято`} sortKey="received" sort={sort} onSort={toggleSort} />
              {showRokhlya && <SortableHead label="Долг рохлей" sortKey="rokhlyaDebt" sort={sort} onSort={toggleSort} />}
              <SortableHead label="Разница" sortKey="diff" sort={sort} onSort={toggleSort} />
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedRows.map(row => {
              const key = row[keyField]
              const isOpen = expanded.has(key)
              return (
                <Fragment key={key}>
                  <TableRow className="cursor-pointer" onClick={() => toggle(key)}>
                    <TableCell className="font-medium">{key}</TableCell>
                    <TableCell className="tabular-nums">{row.routeCount}</TableCell>
                    <TableCell className="tabular-nums">{row[metric.aggShippedField] || 0}</TableCell>
                    <TableCell className="tabular-nums">{row[metric.aggReceivedField] || 0}</TableCell>
                    {showRokhlya && (
                      <TableCell>
                        {row.rokhlyaDebt ? (() => {
                          const debtRoute = (row.routes || [])
                            .filter(r => r.rokhlyaDebt > 0)
                            .sort((a, b) => (a.date || '').localeCompare(b.date || ''))[0] || null
                          return (
                            <div className="flex flex-col gap-0.5">
                              <Badge variant="warning" className="w-fit">{row.rokhlyaDebt}</Badge>
                              {debtRoute && <span className="text-xs text-muted-foreground">с {fmtDate(debtRoute.date)} · {debtRoute.routeNumber}</span>}
                            </div>
                          )
                        })() : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    )}
                    <TableCell><DiffBadge diff={metricAggDiff(row, metric)} /></TableCell>
                    <TableCell>
                      <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
                    </TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={showRokhlya ? 7 : 6} className="bg-muted/30 whitespace-normal">
                        {!row.routes?.length ? (
                          <div className="py-2 text-sm text-muted-foreground">Маршруты не найдены</div>
                        ) : (
                          <div className="space-y-1 py-2">
                            {row.routes.map(r => (
                              <div key={r.routeId} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-card px-3 py-1.5 text-sm">
                                <span className="font-medium">{r.routeNumber || '—'}</span>
                                <span className="text-muted-foreground">{fmtDate(r.date)}</span>
                                {keyField === 'address' && <span className="text-muted-foreground">{r.driver?.name || '—'}</span>}
                                <span className="tabular-nums">↗ {r[metric.shippedField] ?? '—'}</span>
                                <span className="tabular-nums">↙ {r[metric.receivedField] ?? '—'}</span>
                                <DiffBadge diff={metricDiff(r, metric)} />
                              </div>
                            ))}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
