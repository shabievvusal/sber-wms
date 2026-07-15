import { useState, useEffect, useCallback, useMemo, memo } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { cn } from '@/lib/utils'
import { withMinDuration } from '@/lib/timing'
import { setHash } from '@/lib/hashRoute'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Spinner } from '@/components/ui/spinner'
import { Pagination } from '@/components/ui/pagination'
import { DateRangePicker } from '@/components/ui/date-picker'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import {
  Download, FileText, Trash2, Check, Search, X, Pencil, Camera,
  Loader2, Truck, PackageOpen, Scale, ChevronDown,
} from 'lucide-react'
import { METRICS, metricDiff } from './metrics'
import { toggleSortState } from '@/lib/sort'
import { SortableHead } from '@/components/ui/sortable-head'
import { TopLoadingBar } from '@/components/ui/top-loading-bar'
import AggregateView from './AggregateView'
import FetchModal from './FetchModal'
import ReportModal from './ReportModal'
import EditRouteDialog from './EditRouteDialog'
import Lightbox from '@/components/shared/Lightbox'

// ─────────────────────────────────────────────────────────────────────────────
// Эскиз редизайна ShipmentsPage. Тот же подход, что и весь new zlp: Tailwind +
// shadcn/ui вместо module.css. Данные настоящие, идут в реальный бэкенд через
// прокси (см. vite.config.js). Если бэкенд недоступен — страница показывает
// честную ошибку, а не демо-данные.
//
// Все данные оригинальной таблицы (27 колонок + «Фото») на месте, но не все —
// плоскими колонками. Основная сетка (16 колонок, см. COLS) — только то, что
// реально сканируют по всему списку: идентификация маршрута, отгружено/
// принято/разница по выбранному показателю, кто отгрузил/принял, температуры,
// точные даты. Учётные детали — рохли, долг рохлей, «кто подтвердил», фото и
// полная разбивка по видам тары для каждого ЦФЗ-адреса — в разворот по клику
// на строку (RouteRow ниже): это данные для разбора конкретного расхождения,
// не для ежедневного просмотра. Решение — по итогам обсуждения с пользователем.
//
//   - колонки-идентификаторы (чекбокс/дата/маршрут/водитель) закреплены слева,
//     «Действия» — справа (frozen panes, как в Google Sheets), см. PIN/COLS
//   - остальные колонки сгруппированы в шапке (Инфо / Отгрузка / Приёмка /
//     Сверка, см. GroupHead) с разделителями
//   - колонки «отгр./принято/разница» показывают ОДИН показатель за раз —
//     РК, паллеты, ящики или ТЧ (переключатель METRICS над таблицей) — вместо
//     четырёх параллельных пар колонок под каждый вид тары одновременно.
//     Сортировка (клик на заголовок) работает для того показателя, который
//     выбран сейчас
//
// «Коды ЦФЗ» — фича снята по запросу (был отдельный CodesModal + баннер
// missing-codes, теперь их нет ни в API, ни в моках).
//
// Осознанно упрощено относительно оригинала (~2270 строк):
//   - мастер «создать новую отгрузку/приёмку с нуля» (4-шаговый визард с фото) —
//     см. комментарий в EditRouteDialog.jsx, отдельная задача
//   - мобильные карточки (сейчас адаптив только через горизонтальный скролл)
// ─────────────────────────────────────────────────────────────────────────────

function matchesQuery(r, q) {
  if (!q) return true
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  const haystack = [
    r.routeNumber, r.driver?.name, r.vehicle?.model, r.vehicle?.number,
    ...(r.cfzAddresses || []).map(a => a.address),
  ].filter(Boolean).join(' ').toLowerCase()
  return haystack.includes(needle)
}

function matchesNameQuery(entry, keyField, q) {
  if (!q) return true
  return String(entry[keyField] || '').toLowerCase().includes(q.trim().toLowerCase())
}

const ROUTES_PER_PAGE = 30

const STATUS_FILTERS = [
  { id: 'all', label: 'Все' },
  { id: 'shipped', label: 'Отгружены' },
  { id: 'received', label: 'Приняты' },
  { id: 'unconfirmed', label: 'Не подтверждены' },
  { id: 'pending', label: 'Не обработаны' },
]

function fmtDate(d) {
  if (!d) return '—'
  const [y, m, day] = d.slice(0, 10).split('-')
  return `${day}.${m}.${y}`
}

function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function shortFio(name) {
  if (!name) return ''
  const parts = String(name).trim().split(/\s+/)
  if (parts.length < 2) return name
  return `${parts[0]} ${parts[1][0]}.${parts[2] ? parts[2][0] + '.' : ''}`
}

function valOrDash(v) {
  return v != null && v !== '' ? v : <span className="text-muted-foreground">—</span>
}

// Одна строка на адрес ЦФЗ, а не колонка на каждый вид тары — те же данные
// (РК/паллеты/ящики/ТЧ), но текстом через «·», без расширения таблицы.
function formatItemMetrics(item) {
  if (!item) return '—'
  const parts = []
  if (item.rk != null) parts.push(`${item.rk} РК`)
  if (item.pallets) parts.push(`${item.pallets} пал.`)
  if (item.boxes) parts.push(`${item.boxes} ящ.`)
  if (item.thermalCovers) parts.push(`${item.thermalCovers} ТЧ`)
  return parts.length ? parts.join(' · ') : '—'
}

function rowTint(r) {
  const hasShip = !!r.shipment
  const hasRecv = !!r.receiving
  if (!hasShip && !hasRecv) return ''
  if (hasShip && !hasRecv) return 'bg-warning/5 hover:bg-warning/10'
  const bothConfirmed = !!r.shipment?.confirmed && !!r.receiving?.confirmed
  return bothConfirmed ? 'bg-success/5 hover:bg-success/10' : 'bg-warning/10 hover:bg-warning/15'
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

// ── Сортировка (та же логика, что и в оригинале: desc → asc → без сортировки) ──

function sortValue(route, key, metric) {
  switch (key) {
    case 'date': return route.date || ''
    case 'routeNumber': return route.routeNumber || ''
    case 'driver': return route.driver?.name || ''
    case 'shippedAt': return route.shippedAt || ''
    case 'receivedAt': return route.receivedAt || ''
    case 'diff': return metricDiff(route, metric) ?? 0
    default: return route[key] ?? 0
  }
}

function sortRoutes(routes, sort, metric) {
  if (!sort.key || !sort.dir) return routes
  return [...routes].sort((a, b) => {
    const av = sortValue(a, sort.key, metric)
    const bv = sortValue(b, sort.key, metric)
    if (typeof av === 'string') return sort.dir === 'desc' ? bv.localeCompare(av, 'ru') : av.localeCompare(bv, 'ru')
    return sort.dir === 'desc' ? bv - av : av - bv
  })
}

// ── Закреплённые колонки + фиксированная сетка ──────────────────────────────
// Основная таблица — только то, что реально сканируют по всему списку.
// Расшифровка по видам тары (паллеты/ящики/ТЧ), рохли, долг рохлей и «кто
// подтвердил» — в разворот по клику на строку (см. RouteRow ниже): это
// учётные/аудиторские данные, нужные точечно, не при каждом просмотре списка.
//
// Ширины заданы один раз через <colgroup> (COLS ниже) и table-fixed — иначе
// браузер сам решает ширину каждой колонки по содержимому, и sticky-left не
// сможет посчитать точное смещение (текст мог бы «уехать» и сломать заморозку).
// left-* у PIN подобраны под кумулятивную сумму первых 4 ширин из COLS
// (44 → 148 → 278 → 458).
const COLS = [
  44, 104, 130, 180, // чекбокс, дата, маршрут, водитель — закреплены слева
  160, 64, 84, 148, 76, 76, 100,
  92, 148, 96,
  84,
  188, // действия — закреплено справа
]

const PIN = {
  check: 'sticky left-0 z-10 bg-card',
  date: 'sticky left-[44px] z-10 bg-card',
  route: 'sticky left-[148px] z-10 bg-card',
  driver: 'sticky left-[278px] z-10 bg-card border-r border-border shadow-[2px_0_4px_-2px_rgba(0,0,0,0.08)]',
  actions: 'sticky right-0 z-10 bg-card border-l border-border shadow-[-2px_0_4px_-2px_rgba(0,0,0,0.08)]',
}
const PIN_HEAD = {
  check: cn(PIN.check, 'z-20'),
  date: cn(PIN.date, 'z-20'),
  route: cn(PIN.route, 'z-20'),
  driver: cn(PIN.driver, 'z-20'),
  actions: cn(PIN.actions, 'z-20'),
  // Смёрженная ячейка группового ряда (colSpan=4) — та же правая граница/тень,
  // что у driver ниже, иначе вертикальная линия заморозки прервётся на этой строке.
  checkGroup: 'sticky left-0 z-20 bg-card border-r border-border shadow-[2px_0_4px_-2px_rgba(0,0,0,0.08)]',
}

// Граница логической группы колонок (Инфо / Отгрузка / Приёмка / Сверка) —
// тонкая вертикальная линия, чтобы 20+ колонок в скролле не сливались в кашу.
const GROUP_START = 'border-l border-border'

function GroupHead({ icon: Icon, label, colSpan, divider = true }) {
  return (
    <TableHead colSpan={colSpan} className={cn(divider && GROUP_START, 'bg-muted/40 text-center text-xs font-semibold text-muted-foreground')}>
      <span className="inline-flex items-center justify-center gap-1.5">
        {Icon && <Icon className="size-3.5" />} {label}
      </span>
    </TableHead>
  )
}

// Итоговая строка сводки (Рохли/Долг/Подтверждение) внутри разворота —
// одно значение на весь маршрут, не по ЦФЗ. Компактный inline-элемент, а не
// grid-ячейка на всю ширину — иначе label и value расползаются на полэкрана.
function SummaryLine({ label, value, warn }) {
  if (value == null || value === '') return null
  return (
    <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap">
      <span className="text-muted-foreground">{label}:</span>
      <span className={cn('font-medium tabular-nums', warn && 'text-warning-foreground')}>{value}</span>
    </span>
  )
}

const RouteRow = memo(function RouteRow({ route: r, selected, expanded, confirming, metric, onToggleSelect, onToggleExpand, onConfirm, onEdit, onOpenPhotos }) {
  const cfzCount = (r.cfzAddresses || []).length
  const shipPhotos = r.shipment?.photos || []
  const recvPhotos = r.receiving?.photos || []
  const canExpand = cfzCount > 0 || !!r.shipment || !!r.receiving

  return (
    <>
      <TableRow
        className={cn(
          selected && 'bg-muted/40', !selected && rowTint(r),
          canExpand && 'cursor-pointer'
        )}
        onClick={canExpand ? () => onToggleExpand(r.routeId) : undefined}
      >
        <TableCell className={PIN.check} onClick={e => e.stopPropagation()}>
          <Checkbox checked={selected} onCheckedChange={() => onToggleSelect(r.routeId)} />
        </TableCell>
        <TableCell className={cn(PIN.date, 'text-muted-foreground')}>{fmtDate(r.date)}</TableCell>
        <TableCell className={cn(PIN.route, 'font-medium truncate')}>
          <span className="inline-flex items-center gap-1">
            {r.routeNumber || '—'}
            {canExpand && <ChevronDown className={cn('size-3 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')} />}
          </span>
        </TableCell>
        <TableCell className={cn(PIN.driver, 'text-muted-foreground truncate')} title={r.driver?.name || ''}>{shortFio(r.driver?.name) || '—'}</TableCell>
        <TableCell className="text-muted-foreground truncate" title={r.vehicle ? `${r.vehicle.model} ${r.vehicle.number}` : ''}>
          {r.vehicle ? `${r.vehicle.model} ${r.vehicle.number}` : '—'}
        </TableCell>
        <TableCell className="text-muted-foreground">{cfzCount || '—'}</TableCell>
        <TableCell className={cn(GROUP_START, 'tabular-nums')}>{valOrDash(r[metric.shippedField])}</TableCell>
        <TableCell className="text-muted-foreground truncate" title={r.shipment?.by || ''}>{r.shipment?.by || '—'}</TableCell>
        <TableCell className="tabular-nums">{r.shipment?.tempBefore != null ? `${r.shipment.tempBefore}°` : '—'}</TableCell>
        <TableCell className="tabular-nums">{r.shipment?.tempAfter != null ? `${r.shipment.tempAfter}°` : '—'}</TableCell>
        <TableCell className="text-muted-foreground">{fmtDateTime(r.shippedAt)}</TableCell>
        <TableCell className={cn(GROUP_START, 'tabular-nums')}>{valOrDash(r[metric.receivedField])}</TableCell>
        <TableCell className="text-muted-foreground truncate" title={r.receiving?.by || ''}>{r.receiving?.by || '—'}</TableCell>
        <TableCell className="text-muted-foreground">{fmtDateTime(r.receivedAt)}</TableCell>
        <TableCell className={GROUP_START}><DiffBadge diff={metricDiff(r, metric)} /></TableCell>
        <TableCell className={cn(PIN.actions, 'text-right')} onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-end gap-1.5">
            {r.shipment && !r.shipment.confirmed && (
              <Button size="sm" variant="outline" disabled={confirming[r.routeId + 'ship']} onClick={() => onConfirm(r.routeId, 'ship')}>
                {confirming[r.routeId + 'ship'] ? <Loader2 className="animate-spin" /> : <Check />} Отгр.
              </Button>
            )}
            {r.receiving && !r.receiving.confirmed && (
              <Button size="sm" variant="outline" disabled={confirming[r.routeId + 'receive']} onClick={() => onConfirm(r.routeId, 'receive')}>
                {confirming[r.routeId + 'receive'] ? <Loader2 className="animate-spin" /> : <Check />} Пр.
              </Button>
            )}
            <Button size="icon" variant="ghost" title="Изменить" onClick={() => onEdit(r.routeId)}>
              <Pencil className="size-3.5" />
            </Button>
          </div>
        </TableCell>
      </TableRow>

      {expanded && canExpand && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={COLS.length} className="bg-muted/20 p-0">
            <div className="space-y-2 p-2">
              {/* Сводка на весь маршрут — не по ЦФЗ */}
              <div className="flex flex-wrap gap-x-5 gap-y-1">
                <SummaryLine label="Рохли отгружено" value={r.shipment?.rokhlya} />
                <SummaryLine label="Рохли принято" value={r.receiving?.rokhlya} />
                <SummaryLine label="Долг рохлей" value={r.rokhlyaDebt || null} warn />
                <SummaryLine label="Подтв. отгрузку" value={shortFio(r.shipment?.confirmedBy)} />
                <SummaryLine label="Подтв. приёмку" value={shortFio(r.receiving?.confirmedBy)} />
              </div>

              {/* По ЦФЗ — РК/паллеты/ящики/ТЧ те же, что и раньше, но одной
                  текстовой строкой на адрес через «·», а не колонкой на
                  каждый вид тары — иначе это снова расширяет таблицу */}
              {cfzCount > 0 && (
                <div className="space-y-1">
                  {r.cfzAddresses.map(a => {
                    const s = r.shipment?.items?.find(i => i.address === a.address)
                    const v = r.receiving?.items?.find(i => i.address === a.address)
                    return (
                      <div key={a.address} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
                        <span className="w-48 truncate font-medium" title={a.address}>{a.address}</span>
                        <span className="tabular-nums text-muted-foreground">↗ {formatItemMetrics(s)}</span>
                        <span className={cn(GROUP_START, 'pl-3 tabular-nums text-muted-foreground')}>↙ {formatItemMetrics(v)}</span>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Фото — было отдельной колонкой в основной таблице, здесь нужнее.
                  Разделены отгрузка/приёмка той же вертикальной линией, что и
                  остальные пары «отгружено | принято» в этом развороте. */}
              <div className="flex items-center gap-3">
                <Button
                  size="sm" variant="outline" disabled={!shipPhotos.length}
                  onClick={e => { e.stopPropagation(); onOpenPhotos(shipPhotos, 0) }}
                >
                  <Camera className="size-3.5" /> Фото отгрузки{shipPhotos.length ? ` (${shipPhotos.length})` : ''}
                </Button>
                <span className={cn(GROUP_START, 'pl-3')}>
                  <Button
                    size="sm" variant="outline" disabled={!recvPhotos.length}
                    onClick={e => { e.stopPropagation(); onOpenPhotos(recvPhotos, 0) }}
                  >
                    <Camera className="size-3.5" /> Фото приёмки{recvPhotos.length ? ` (${recvPhotos.length})` : ''}
                  </Button>
                </span>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
})

// Мобильная карточка — та же информация, что и в RouteRow (всегда видимое +
// разворот по клику), просто в вертикальной раскладке вместо строки таблицы с
// 16 закреплёнными колонками. Брейкпоинт — `md` (768px), как и в оригинале
// (`.mCardList`/`.desktopOnly`, CSS media query на том же 768px).
const MobileRouteCard = memo(function MobileRouteCard({ route: r, confirming, metric, onConfirm, onEdit, onOpenPhotos }) {
  const [open, setOpen] = useState(false)
  const cfzCount = (r.cfzAddresses || []).length
  const shipPhotos = r.shipment?.photos || []
  const recvPhotos = r.receiving?.photos || []
  const canExpand = cfzCount > 0 || !!r.shipment || !!r.receiving

  const hasShipment = !!r.shipment
  const hasReceiving = !!r.receiving
  const shipConfirmed = !!r.shipment?.confirmed
  const recvConfirmed = !!r.receiving?.confirmed

  let statusLabel = 'Не отгружен'
  let statusVariant = 'secondary'
  if (hasShipment && !hasReceiving) { statusLabel = 'Ожидает приёмки'; statusVariant = 'warning' }
  else if (hasShipment && hasReceiving && shipConfirmed && recvConfirmed) { statusLabel = 'Завершён'; statusVariant = 'success' }
  else if (hasShipment && hasReceiving) { statusLabel = 'Ждёт подтверждения'; statusVariant = 'warning' }

  return (
    <div className={cn('p-3', rowTint(r))}>
      <div
        className={cn('flex items-start justify-between gap-2', canExpand && 'cursor-pointer')}
        onClick={canExpand ? () => setOpen(o => !o) : undefined}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1 font-medium">
            <span className="truncate">{r.routeNumber || '—'}</span>
            {canExpand && <ChevronDown className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />}
          </div>
          <div className="truncate text-xs text-muted-foreground">{fmtDate(r.date)} · {shortFio(r.driver?.name) || '—'}</div>
        </div>
        <Badge variant={statusVariant} className="shrink-0">{statusLabel}</Badge>
      </div>

      <div className="mt-2 flex items-center gap-4 text-sm">
        <span><span className="text-muted-foreground">{metric.label} отгр. </span><span className="tabular-nums font-medium">{valOrDash(r[metric.shippedField])}</span></span>
        <span><span className="text-muted-foreground">принято </span><span className="tabular-nums font-medium">{valOrDash(r[metric.receivedField])}</span></span>
        <span className="ml-auto"><DiffBadge diff={metricDiff(r, metric)} /></span>
      </div>

      {open && canExpand && (
        <div className="mt-3 space-y-2 border-t pt-2" onClick={e => e.stopPropagation()}>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <SummaryLine label="Рохли отгружено" value={r.shipment?.rokhlya} />
            <SummaryLine label="Рохли принято" value={r.receiving?.rokhlya} />
            <SummaryLine label="Долг рохлей" value={r.rokhlyaDebt || null} warn />
            <SummaryLine label="Подтв. отгрузку" value={shortFio(r.shipment?.confirmedBy)} />
            <SummaryLine label="Подтв. приёмку" value={shortFio(r.receiving?.confirmedBy)} />
          </div>

          {cfzCount > 0 && (
            <div className="space-y-1">
              {r.cfzAddresses.map(a => {
                const s = r.shipment?.items?.find(i => i.address === a.address)
                const v = r.receiving?.items?.find(i => i.address === a.address)
                return (
                  <div key={a.address} className="text-sm">
                    <div className="truncate font-medium" title={a.address}>{a.address}</div>
                    <div className="flex gap-3 text-muted-foreground tabular-nums">
                      <span>↗ {formatItemMetrics(s)}</span>
                      <span>↙ {formatItemMetrics(v)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {(shipPhotos.length > 0 || recvPhotos.length > 0) && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" disabled={!shipPhotos.length} onClick={() => onOpenPhotos(shipPhotos, 0)}>
                <Camera className="size-3.5" /> Фото отгр.{shipPhotos.length ? ` (${shipPhotos.length})` : ''}
              </Button>
              <Button size="sm" variant="outline" disabled={!recvPhotos.length} onClick={() => onOpenPhotos(recvPhotos, 0)}>
                <Camera className="size-3.5" /> Фото прием.{recvPhotos.length ? ` (${recvPhotos.length})` : ''}
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5" onClick={e => e.stopPropagation()}>
        {hasShipment && !shipConfirmed && (
          <Button size="sm" variant="outline" disabled={confirming[r.routeId + 'ship']} onClick={() => onConfirm(r.routeId, 'ship')}>
            {confirming[r.routeId + 'ship'] ? <Loader2 className="animate-spin" /> : <Check />} Отгр.
          </Button>
        )}
        {hasReceiving && !recvConfirmed && (
          <Button size="sm" variant="outline" disabled={confirming[r.routeId + 'receive']} onClick={() => onConfirm(r.routeId, 'receive')}>
            {confirming[r.routeId + 'receive'] ? <Loader2 className="animate-spin" /> : <Check />} Пр.
          </Button>
        )}
        <Button size="icon" variant="ghost" title="Изменить" onClick={() => onEdit(r.routeId)}>
          <Pencil className="size-3.5" />
        </Button>
      </div>
    </div>
  )
})

export default function ShipmentsPage() {
  const [activeTab, setActiveTab] = useState('routes')

  // ── Routes tab ──────────────────────────────────────────────────────────
  const [routes, setRoutes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [sort, setSort] = useState({ key: null, dir: null })
  const [metricKey, setMetricKey] = useState('rk')
  const activeMetric = METRICS.find(m => m.key === metricKey) || METRICS[0]

  const [selected, setSelected] = useState(() => new Set())
  const [expanded, setExpanded] = useState(() => new Set())
  const [confirming, setConfirming] = useState({})
  const [page, setPage] = useState(1)

  const [lightbox, setLightbox] = useState(null) // { photos, idx } | null
  const [editRouteId, setEditRouteId] = useState(null)
  const [fetchModalOpen, setFetchModalOpen] = useState(false)
  const [reportModalOpen, setReportModalOpen] = useState(false)

  // ── Drivers / CFZ tabs ───────────────────────────────────────────────────
  const [driversData, setDriversData] = useState([])
  const [driversLoading, setDriversLoading] = useState(false)
  const [driversError, setDriversError] = useState('')
  const [driversSearch, setDriversSearch] = useState('')

  const [cfzData, setCfzData] = useState([])
  const [cfzLoading, setCfzLoading] = useState(false)
  const [cfzError, setCfzError] = useState('')
  const [cfzSearch, setCfzSearch] = useState('')

  const load = useCallback(async q => {
    setLoading(true); setError('')
    await withMinDuration(async () => {
      try {
        setRoutes(await api.getRkRoutes({ q }))
      } catch (err) {
        setRoutes([])
        setError(err.message || 'Не удалось загрузить маршруты')
      }
    })
    setLoading(false)
  }, [])

  const loadDrivers = useCallback(async q => {
    setDriversLoading(true); setDriversError('')
    await withMinDuration(async () => {
      try { setDriversData(await api.getRkDrivers(q)) }
      catch (err) { setDriversData([]); setDriversError(err.message || 'Не удалось загрузить водителей') }
    })
    setDriversLoading(false)
  }, [])

  const loadCfz = useCallback(async q => {
    setCfzLoading(true); setCfzError('')
    await withMinDuration(async () => {
      try { setCfzData(await api.getRkCfz(q)) }
      catch (err) { setCfzData([]); setCfzError(err.message || 'Не удалось загрузить ЦФЗ') }
    })
    setCfzLoading(false)
  }, [])

  useEffect(() => { load('') }, [load])

  useEffect(() => {
    const t = setTimeout(() => load(search), 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  useEffect(() => {
    if (activeTab !== 'drivers') return
    const t = setTimeout(() => loadDrivers(driversSearch), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, driversSearch])

  useEffect(() => {
    if (activeTab !== 'cfz') return
    const t = setTimeout(() => loadCfz(cfzSearch), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, cfzSearch])

  const filtered = useMemo(() => routes.filter(r => {
    if (statusFilter === 'shipped' && !r.shipment) return false
    if (statusFilter === 'received' && !r.receiving) return false
    if (statusFilter === 'unconfirmed' && !((r.shipment && !r.shipment.confirmed) || (r.receiving && !r.receiving.confirmed))) return false
    if (statusFilter === 'pending' && (r.shipment || r.receiving)) return false
    if (dateFrom && r.date && r.date < dateFrom) return false
    if (dateTo && r.date && r.date > dateTo) return false
    return true
  }), [routes, statusFilter, dateFrom, dateTo])

  const sorted = useMemo(() => sortRoutes(filtered, sort, activeMetric), [filtered, sort, activeMetric])
  const toggleSort = key => setSort(s => toggleSortState(s, key))
  const changeMetric = key => { setMetricKey(key); setSort({ key: null, dir: null }) }

  const totalPages = Math.max(1, Math.ceil(sorted.length / ROUTES_PER_PAGE))
  const curPage = Math.min(page, totalPages)
  const pageData = sorted.slice((curPage - 1) * ROUTES_PER_PAGE, curPage * ROUTES_PER_PAGE)
  const allOnPageSelected = pageData.length > 0 && pageData.every(r => selected.has(r.routeId))
  const editRoute = editRouteId ? routes.find(r => r.routeId === editRouteId) || null : null

  const toggleSelect = id => setSelected(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const toggleExpand = id => setExpanded(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const toggleSelectAllOnPage = () => setSelected(prev => {
    const next = new Set(prev)
    pageData.forEach(r => allOnPageSelected ? next.delete(r.routeId) : next.add(r.routeId))
    return next
  })

  const handleRouteUpdate = useCallback((routeId, newRoute) => {
    setRoutes(prev => prev.map(r => r.routeId === routeId ? newRoute : r))
  }, [])

  const confirmSingle = useCallback(async (routeId, atype) => {
    setConfirming(c => ({ ...c, [routeId + atype]: true }))
    try {
      const res = atype === 'ship' ? await api.confirmRkShipment(routeId) : await api.confirmRkReceiving(routeId)
      if (!res.ok) throw new Error(res.error || 'Ошибка')
      setRoutes(prev => prev.map(r => r.routeId === routeId ? res.route : r))
      toast.success(atype === 'ship' ? 'Отгрузка подтверждена' : 'Приёмка подтверждена')
    } catch (err) { toast.error('Ошибка: ' + err.message) }
    finally { setConfirming(c => ({ ...c, [routeId + atype]: false })) }
  }, [])

  const bulkDelete = async () => {
    const ids = [...selected]
    if (!ids.length) return
    if (!confirm(`Удалить ${ids.length} маршрут(ов)? Это действие нельзя отменить.`)) return
    try {
      const res = await api.deleteRkRoutesBulk(ids)
      if (!res.ok) throw new Error(res.error || 'Ошибка')
      setRoutes(prev => prev.filter(r => !ids.includes(r.routeId)))
      setSelected(new Set())
      toast.success(`Удалено маршрутов: ${ids.length}`)
    } catch (err) { toast.error('Ошибка: ' + err.message) }
  }

  return (
    <div className="mx-auto w-full max-w-[2400px] p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Отгрузка и приёмка (РК, ЯЩ, ТЧ, паллеты)</h1>
          <p className="text-sm text-muted-foreground">Маршруты СТПС: отгрузка, приёмка, сверка расхождений</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setHash('receive')} title="Форма отгрузки/приёмки — кио­ск для кладовщика на складе">
            <PackageOpen /> Форма отгрузки
          </Button>
          <Button variant="secondary" onClick={() => setFetchModalOpen(true)}>
            <Download /> Загрузить из WMS
          </Button>
          <Button variant="secondary" onClick={() => setReportModalOpen(true)}>
            <FileText /> Отчёт
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="routes">По маршрутам</TabsTrigger>
            <TabsTrigger value="drivers">По водителям</TabsTrigger>
            <TabsTrigger value="cfz">По ЦФЗ</TabsTrigger>
          </TabsList>

          {/* Показатель в колонках «отгр./принято/разница» — общий для всех
              трёх вкладок, вместо четырёх пар колонок под РК/паллеты/ящики/ТЧ
              одновременно в каждой */}
          <div className="flex items-center gap-1.5 rounded-md border bg-muted/30 p-1">
            {METRICS.map(m => (
              <Button
                key={m.key}
                size="sm"
                variant={metricKey === m.key ? 'default' : 'ghost'}
                onClick={() => changeMetric(m.key)}
              >
                {m.label}
              </Button>
            ))}
          </div>
        </div>

        {/* ── По маршрутам ── */}
        <TabsContent value="routes" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Поиск по маршруту, водителю, адресу ЦФЗ..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {STATUS_FILTERS.map(f => (
                <Button
                  key={f.id}
                  size="sm"
                  variant={statusFilter === f.id ? 'default' : 'outline'}
                  onClick={() => { setStatusFilter(f.id); setPage(1) }}
                >
                  {f.label}
                </Button>
              ))}
            </div>
            <DateRangePicker
              className="ml-auto w-[240px]"
              from={dateFrom}
              to={dateTo}
              onChange={({ from, to }) => { setDateFrom(from); setDateTo(to) }}
              placeholder="Любой период"
            />
          </div>

          {selected.size > 0 && (
            <div className="flex items-center gap-2 rounded-lg border bg-card px-4 py-2.5">
              <span className="text-sm font-medium">Выбрано: {selected.size}</span>
              <div className="ml-auto flex gap-2">
                <Button size="sm" variant="destructive" onClick={bulkDelete}><Trash2 /> Удалить</Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}><X /> Снять выбор</Button>
              </div>
            </div>
          )}

          <div className="relative rounded-lg border bg-card">
            <TopLoadingBar active={loading && routes.length > 0} />
            {loading && !routes.length ? (
              // Спиннер — только пока данных вообще ещё не было (первая загрузка
              // страницы). При повторных загрузках (поиск, обновление вкладки)
              // старая таблица остаётся на месте как есть — вместо мигания
              // содержимым показываем тонкую полосу загрузки сверху (TopLoadingBar).
              <Spinner label="Загрузка маршрутов..." />
            ) : error ? (
              <div className="p-6 text-sm text-destructive">{error}</div>
            ) : !pageData.length ? (
              <div className="p-10 text-center text-sm text-muted-foreground">Нет маршрутов по заданным фильтрам</div>
            ) : (
              <>
                {/* Мобильные карточки — до md (768px), см. MobileRouteCard выше */}
                <div className="divide-y md:hidden">
                  {pageData.map(r => (
                    <MobileRouteCard
                      key={r.routeId}
                      route={r}
                      confirming={confirming}
                      metric={activeMetric}
                      onConfirm={confirmSingle}
                      onEdit={setEditRouteId}
                      onOpenPhotos={(photos, idx) => setLightbox({ photos, idx })}
                    />
                  ))}
                </div>

                {/* Десктопная таблица — от md и шире */}
                <div className="hidden md:block">
                  <Table className="table-fixed">
                    <colgroup>
                      {COLS.map((w, i) => <col key={i} style={{ width: w }} />)}
                    </colgroup>
                    <TableHeader>
                      {/* Группы колонок — ориентир, пока листаешь таблицу вбок */}
                      <TableRow className="hover:bg-transparent">
                        <TableHead colSpan={4} className={PIN_HEAD.checkGroup} />
                        <GroupHead label="Инфо" colSpan={2} divider={false} />
                        <GroupHead icon={Truck} label="Отгрузка" colSpan={5} />
                        <GroupHead icon={PackageOpen} label="Приёмка" colSpan={3} />
                        <GroupHead icon={Scale} label="Сверка" colSpan={1} />
                        <TableHead className={PIN_HEAD.actions} />
                      </TableRow>
                      <TableRow>
                        <TableHead className={PIN_HEAD.check}>
                          <Checkbox checked={allOnPageSelected} onCheckedChange={toggleSelectAllOnPage} />
                        </TableHead>
                        <SortableHead label="Дата" sortKey="date" sort={sort} onSort={toggleSort} className={PIN_HEAD.date} />
                        <SortableHead label="Маршрут" sortKey="routeNumber" sort={sort} onSort={toggleSort} className={PIN_HEAD.route} />
                        <SortableHead label="Водитель" sortKey="driver" sort={sort} onSort={toggleSort} className={PIN_HEAD.driver} />
                        <TableHead className="truncate">ТС</TableHead>
                        <TableHead>ЦФЗ</TableHead>
                        <SortableHead label={`${activeMetric.label} отгр.`} sortKey={activeMetric.shippedField} sort={sort} onSort={toggleSort} className={GROUP_START} />
                        <TableHead className="truncate">Кто отгрузил</TableHead>
                        <TableHead>Темп.до°</TableHead>
                        <TableHead>Темп.пос.°</TableHead>
                        <SortableHead label="Дата отгр." sortKey="shippedAt" sort={sort} onSort={toggleSort} />
                        <SortableHead label={`${activeMetric.label} принято`} sortKey={activeMetric.receivedField} sort={sort} onSort={toggleSort} className={GROUP_START} />
                        <TableHead className="truncate">Кто принял</TableHead>
                        <SortableHead label="Дата прин." sortKey="receivedAt" sort={sort} onSort={toggleSort} />
                        <SortableHead label="Разница" sortKey="diff" sort={sort} onSort={toggleSort} className={GROUP_START} />
                        <TableHead className={cn(PIN_HEAD.actions, 'text-right')}>Действия</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pageData.map(r => (
                        <RouteRow
                          key={r.routeId}
                          route={r}
                          selected={selected.has(r.routeId)}
                          expanded={expanded.has(r.routeId)}
                          confirming={confirming}
                          metric={activeMetric}
                          onToggleSelect={toggleSelect}
                          onToggleExpand={toggleExpand}
                          onConfirm={confirmSingle}
                          onEdit={setEditRouteId}
                          onOpenPhotos={(photos, idx) => setLightbox({ photos, idx })}
                        />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Стр. {curPage}/{totalPages} • {(curPage - 1) * ROUTES_PER_PAGE + 1}–{Math.min(curPage * ROUTES_PER_PAGE, sorted.length)} из {sorted.length}
              </span>
              <Pagination page={curPage} totalPages={totalPages} onChange={setPage} />
            </div>
          )}
        </TabsContent>

        {/* ── По водителям ── */}
        <TabsContent value="drivers" className="space-y-4">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" placeholder="Поиск по водителю..." value={driversSearch} onChange={e => setDriversSearch(e.target.value)} />
          </div>
          <AggregateView
            rows={driversData}
            loading={driversLoading}
            error={driversError}
            keyField="name"
            keyLabel="Водитель"
            showRokhlya
            metric={activeMetric}
            emptyLabel="Нет данных по водителям"
          />
        </TabsContent>

        {/* ── По ЦФЗ ── */}
        <TabsContent value="cfz" className="space-y-4">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" placeholder="Поиск по адресу ЦФЗ..." value={cfzSearch} onChange={e => setCfzSearch(e.target.value)} />
          </div>
          <AggregateView
            rows={cfzData}
            loading={cfzLoading}
            error={cfzError}
            keyField="address"
            keyLabel="Адрес ЦФЗ"
            showRokhlya={false}
            metric={activeMetric}
            emptyLabel="Нет данных по ЦФЗ"
          />
        </TabsContent>
      </Tabs>

      <FetchModal open={fetchModalOpen} onOpenChange={setFetchModalOpen} onDone={() => load(search)} />
      <ReportModal open={reportModalOpen} onOpenChange={setReportModalOpen} />
      <EditRouteDialog
        route={editRoute}
        open={!!editRouteId}
        onOpenChange={open => !open && setEditRouteId(null)}
        onSaved={handleRouteUpdate}
      />
      {lightbox && (
        <Lightbox
          photos={lightbox.photos}
          idx={lightbox.idx}
          onClose={() => setLightbox(null)}
          onNav={dir => setLightbox(prev => ({ ...prev, idx: (prev.idx + dir + prev.photos.length) % prev.photos.length }))}
        />
      )}
    </div>
  )
}
