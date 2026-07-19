import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { setHash } from '@/lib/hashRoute'
import Lightbox from '@/components/shared/Lightbox'
import FetchModal from './FetchModal'
import ReportModal from './ReportModal'
import styles from './ShipmentsPageClassic.module.css'
import {
  X, Check, Pencil, Trash2, Download, FileText, Camera, Truck, PackageOpen, Car,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Классический (оригинальный) визуальный дизайн раздела «Отгрузка» — часть
// делопроизводителей просила вернуть его как опцию (тумблер в Настройках,
// см. ShipmentsDesignCard.jsx), т.к. не всем понравился новый Tailwind-дизайн
// (ShipmentsPage.jsx). Портировано из оригинала (zlp-main-main/frontend/app/
// src/pages/shipments/ShipmentsPage.jsx, RoutesView/DriversView/CfzView/
// FormStep4Edit) почти дословно — структура таблиц, пороги статусов, все 27
// колонок сразу видны (без переключателя показателя РК/пал./ящ./ТЧ нового
// дизайна). Только просмотр/редактирование СУЩЕСТВУЮЩИХ маршрутов — мастер
// «создать с нуля» (шаги 1-3 оригинала) и «Коды ЦФЗ» сознательно не перенесены
// (то же решение уже принято при портировании нового дизайна). SSE-автообновление
// оригинала тоже не перенесено — не было отдельной жалобы на его отсутствие,
// а new zlp вообще не использует SSE нигде.
//
// Общее с новым дизайном (не дублируем): реальные вызовы @/lib/api (те же
// getRkRoutes/getRkDrivers/getRkCfz/confirm*/deleteRkRoutesBulk/updateRk*/
// uploadRkPhotos), общий фотовьюер @/components/shared/Lightbox, FetchModal/
// ReportModal. Только сама таблица/карточки/форма редактирования — в старой
// вёрстке (CSS Modules, ShipmentsPageClassic.module.css).
// ─────────────────────────────────────────────────────────────────────────────

const ROUTES_PER_PAGE = 50

function shortFio(name) {
  if (!name) return ''
  const parts = String(name).trim().split(/\s+/)
  if (parts.length < 2) return name
  return `${parts[0]} ${parts[1][0]}.${parts[2] ? parts[2][0] + '.' : ''}`
}

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

function thumbUrl(url) {
  if (url.startsWith('http')) {
    return url.replace('/rk-photos/', '/rk-photos/thumbs/').replace(/\.\w+$/, '.jpg')
  }
  return url.replace('/rk-photos/', '/rk-photos/thumb/')
}

function DiffVal({ diff }) {
  if (diff == null) return <span className={styles.naVal}>—</span>
  if (diff > 0) return <span className={styles.diffPlus}>+{diff}</span>
  if (diff < 0) return <span className={styles.diffMinus}>{diff}</span>
  return <span className={styles.diffZero}>0</span>
}

function SortArrow({ sort, col }) {
  if (sort.key !== col) return <span className={`${styles.sortArrow} ${styles.sortNone}`}>⇅</span>
  return <span className={`${styles.sortArrow} ${styles.sortActive}`}>{sort.dir === 'desc' ? '↓' : '↑'}</span>
}

function toggleSortState(sort, key) {
  if (sort.key === key) {
    const dir = sort.dir === 'desc' ? 'asc' : sort.dir === 'asc' ? null : 'desc'
    return dir === null ? { key: null, dir: null } : { key, dir }
  }
  return { key, dir: 'desc' }
}

function sortedData(data, sort) {
  if (!sort.key || !sort.dir) return data
  return [...data].sort((a, b) => {
    const av = a[sort.key] ?? 0
    const bv = b[sort.key] ?? 0
    return sort.dir === 'desc' ? bv - av : av - bv
  })
}

function useLocalState(key, defaultValue) {
  const [value, setValue] = useState(() => {
    try {
      const s = localStorage.getItem(key)
      return s !== null ? JSON.parse(s) : defaultValue
    } catch { return defaultValue }
  })
  const set = useCallback(valOrFn => {
    setValue(prev => {
      const next = typeof valOrFn === 'function' ? valOrFn(prev) : valOrFn
      try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [key])
  return [value, set]
}

function useLocalSet(key) {
  const [value, setValue] = useState(() => {
    try {
      const s = localStorage.getItem(key)
      return s !== null ? new Set(JSON.parse(s)) : new Set()
    } catch { return new Set() }
  })
  const set = useCallback(valOrFn => {
    setValue(prev => {
      const next = typeof valOrFn === 'function' ? valOrFn(prev) : valOrFn
      try { localStorage.setItem(key, JSON.stringify([...next])) } catch { /* ignore */ }
      return next
    })
  }, [key])
  return [value, set]
}

// ─── Routes view ──────────────────────────────────────────────────────────────

function routeSortCmp(a, b, key, dir) {
  let av, bv
  switch (key) {
    case 'date':        av = a.date || '';         bv = b.date || '';         break
    case 'routeNumber': av = a.routeNumber || '';   bv = b.routeNumber || ''; break
    case 'driver':      av = a.driver?.name || '';  bv = b.driver?.name || ''; break
    case 'shippedRK':   av = a.shippedRK;           bv = b.shippedRK;          break
    case 'shippedAt':   av = a.shippedAt || null;   bv = b.shippedAt || null;  break
    case 'receivedRK':  av = a.receivedRK;          bv = b.receivedRK;         break
    case 'receivedAt':  av = a.receivedAt || null;  bv = b.receivedAt || null; break
    case 'diff':        av = a.diff;                bv = b.diff;               break
    default: return 0
  }
  if (av == null && bv == null) return 0
  if (av == null) return 1
  if (bv == null) return -1
  const cmp = typeof av === 'string' ? av.localeCompare(bv, 'ru') : av - bv
  return dir === 'desc' ? -cmp : cmp
}

function RoutesView({ data, loading, error, onOpenLightbox, onOpenEdit, onDataUpdate, onBulkDelete }) {
  const [page, setPage] = useLocalState('sh_classic_routes_page', 1)
  const [sort, setSort] = useLocalState('sh_classic_routes_sort', { key: null, dir: null })
  const [expanded, setExpanded] = useLocalSet('sh_classic_routes_expanded')
  const [selected, setSelected] = useLocalSet('sh_classic_routes_selected')
  const [bulkMsg, setBulkMsg] = useState(null)
  const [confirming, setConfirming] = useState({})

  const toggleSort = col => { setSort(s => toggleSortState(s, col)); setPage(1) }

  const isFirstData = useRef(true)
  useEffect(() => {
    if (isFirstData.current) { isFirstData.current = false; return }
    setPage(1)
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const sorted = useMemo(() => sort.key && sort.dir
    ? [...data].sort((a, b) => routeSortCmp(a, b, sort.key, sort.dir))
    : data
  , [data, sort.key, sort.dir])

  const totalPages = Math.max(1, Math.ceil(sorted.length / ROUTES_PER_PAGE))
  const curPage = Math.min(page, totalPages)
  const pageData = useMemo(
    () => sorted.slice((curPage - 1) * ROUTES_PER_PAGE, curPage * ROUTES_PER_PAGE),
    [sorted, curPage]
  )

  const toggleExpand = useCallback(id => setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n }), [setExpanded])
  const toggleSelect = useCallback(id => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n }), [setSelected])

  const allOnPageChecked = pageData.length > 0 && pageData.every(r => selected.has(r.routeId))
  const toggleSelectAll = checked => {
    setSelected(s => {
      const n = new Set(s)
      pageData.forEach(r => checked ? n.add(r.routeId) : n.delete(r.routeId))
      return n
    })
  }

  const confirmSingle = useCallback(async (routeId, atype) => {
    setConfirming(c => ({ ...c, [routeId + atype]: true }))
    try {
      const res = atype === 'ship' ? await api.confirmRkShipment(routeId) : await api.confirmRkReceiving(routeId)
      if (!res.ok) throw new Error(res.error || 'Ошибка')
      onDataUpdate(routeId, res.route)
      toast.success(atype === 'ship' ? 'Отгрузка подтверждена' : 'Приёмка подтверждена')
    } catch (err) { toast.error('Ошибка: ' + err.message) }
    finally { setConfirming(c => ({ ...c, [routeId + atype]: false })) }
  }, [onDataUpdate])

  const bulkConfirm = async baction => {
    const ids = [...selected]
    const fn = baction === 'confirm-ship' ? api.confirmRkShipment : api.confirmRkReceiving
    let done = 0
    for (const id of ids) {
      try {
        const res = await fn(id)
        if (res.ok) { onDataUpdate(id, res.route); setSelected(s => { const n = new Set(s); n.delete(id); return n }) }
      } catch { /* skip */ }
      done++
      setBulkMsg(`Подтверждаю: ${done}/${ids.length}`)
    }
    setBulkMsg(null)
  }

  const bulkDelete = async () => {
    const ids = [...selected]
    if (!confirm(`Удалить ${ids.length} маршрут${ids.length === 1 ? '' : ids.length < 5 ? 'а' : 'ов'}? Это действие нельзя отменить.`)) return
    setBulkMsg('Удаляю...')
    try {
      const res = await api.deleteRkRoutesBulk(ids)
      if (res.ok) {
        onBulkDelete(ids)
        setSelected(new Set())
        toast.success(`Удалено маршрутов: ${ids.length}`)
      } else {
        toast.error('Ошибка: ' + (res.error || 'неизвестная ошибка'))
      }
    } catch (err) { toast.error('Ошибка: ' + err.message) }
    finally { setBulkMsg(null) }
  }

  if (loading) return <div className={styles.loading}>Загрузка...</div>
  if (error)   return <div className={styles.error}>{error}</div>
  if (!data.length) return <div className={styles.empty}>Нет маршрутов. Загрузите из WMS.</div>

  return (
    <>
      {selected.size > 0 && (
        <div className={styles.bulkBar}>
          <span className={styles.bulkCount}>{bulkMsg || `Выбрано: ${selected.size}`}</span>
          <button className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`} onClick={() => bulkConfirm('confirm-ship')}><Check size={13} strokeWidth={2.5} />Подтвердить отгрузку</button>
          <button className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`} onClick={() => bulkConfirm('confirm-receive')}><Check size={13} strokeWidth={2.5} />Подтвердить приёмку</button>
          <button className={`${styles.btn} ${styles.btnSm} ${styles.btnDanger}`} onClick={bulkDelete}><Trash2 size={13} strokeWidth={2} />Удалить выбранные</button>
          <button className={`${styles.btn} ${styles.btnSm} ${styles.btnSecondary}`} onClick={() => setSelected(new Set())}><X size={13} strokeWidth={2} />Снять выбор</button>
        </div>
      )}

      {/* Mobile cards */}
      <div className={styles.mCardList}>
        {pageData.map(r => (
          <MobileRouteCard
            key={r.routeId}
            route={r}
            confirming={confirming}
            onConfirm={confirmSingle}
            onEdit={onOpenEdit}
            onLightbox={onOpenLightbox}
          />
        ))}
      </div>

      {/* Desktop table */}
      <div className={styles.desktopOnly}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.thCheck}>
                <input type="checkbox" checked={allOnPageChecked} onChange={e => toggleSelectAll(e.target.checked)} />
              </th>
              <th className={styles.thSort} onClick={() => toggleSort('date')}>Дата <SortArrow sort={sort} col="date" /></th>
              <th className={styles.thSort} onClick={() => toggleSort('routeNumber')}>Маршрут <SortArrow sort={sort} col="routeNumber" /></th>
              <th className={styles.thSort} onClick={() => toggleSort('driver')}>Водитель <SortArrow sort={sort} col="driver" /></th>
              <th>ТС</th><th>ЦФЗ</th>
              <th className={`${styles.thNum} ${styles.thSort}`} onClick={() => toggleSort('shippedRK')}>РК отгр. <SortArrow sort={sort} col="shippedRK" /></th>
              <th className={styles.thNum}>Пал.↗</th>
              <th className={styles.thNum}>Ящ.↗</th>
              <th className={styles.thNum}>ТЧ↗</th>
              <th className={styles.thNum}>Рохли↗</th>
              <th>Кто отгрузил</th>
              <th className={styles.thNum}>Темп.до°</th>
              <th className={styles.thNum}>Темп.пос.°</th>
              <th className={`${styles.thNum} ${styles.thSort}`} onClick={() => toggleSort('shippedAt')}>Дата отгр. <SortArrow sort={sort} col="shippedAt" /></th>
              <th className={`${styles.thNum} ${styles.thSort}`} onClick={() => toggleSort('receivedRK')}>РК принято <SortArrow sort={sort} col="receivedRK" /></th>
              <th className={styles.thNum}>Пал.↙</th>
              <th className={styles.thNum}>Ящ.↙</th>
              <th className={styles.thNum}>ТЧ↙</th>
              <th className={styles.thNum}>Рохли↙</th>
              <th className={styles.thNum}>Долг рохлей</th>
              <th>Кто принял</th>
              <th className={`${styles.thNum} ${styles.thSort}`} onClick={() => toggleSort('receivedAt')}>Дата прин. <SortArrow sort={sort} col="receivedAt" /></th>
              <th className={`${styles.thNum} ${styles.thSort}`} onClick={() => toggleSort('diff')}>Разница <SortArrow sort={sort} col="diff" /></th>
              <th>Подтв. отгр.</th><th>Подтв. пр.</th>
              <th className={styles.thActions}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {pageData.map(r => (
              <RouteRows
                key={r.routeId}
                route={r}
                expanded={expanded.has(r.routeId)}
                selected={selected.has(r.routeId)}
                confirming={confirming}
                onToggleExpand={toggleExpand}
                onToggleSelect={toggleSelect}
                onConfirm={confirmSingle}
                onEdit={onOpenEdit}
                onLightbox={onOpenLightbox}
              />
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1
        ? <div className={styles.pagination}>
            <button className={styles.pageBtn} disabled={curPage === 1} onClick={() => setPage(1)}>«</button>
            <button className={styles.pageBtn} disabled={curPage === 1} onClick={() => setPage(p => p - 1)}>‹</button>
            <span className={styles.pageInfo}>Стр. {curPage} из {totalPages} · всего {data.length}</span>
            <button className={styles.pageBtn} disabled={curPage === totalPages} onClick={() => setPage(p => p + 1)}>›</button>
            <button className={styles.pageBtn} disabled={curPage === totalPages} onClick={() => setPage(totalPages)}>»</button>
          </div>
        : <div className={styles.pageInfoSimple}>Всего: {data.length}</div>
      }
    </>
  )
}

const RouteRows = memo(function RouteRows({ route: r, expanded, selected, confirming, onToggleExpand, onToggleSelect, onConfirm, onEdit, onLightbox }) {
  const hasShipment = !!r.shipment
  const hasReceiving = !!r.receiving
  const shipConfirmed = !!r.shipment?.confirmed
  const recvConfirmed = !!r.receiving?.confirmed

  let rowStatusClass = ''
  if (hasShipment && !hasReceiving) rowStatusClass = styles.rowPending
  else if (hasShipment && hasReceiving) rowStatusClass = (shipConfirmed && recvConfirmed) ? styles.rowCompleted : styles.rowAwaitConfirm
  else if (!hasShipment && hasReceiving) rowStatusClass = styles.rowAwaitConfirm

  const shipConfirmEl = r.shipment
    ? (!r.shipment.confirmed
        ? <button className={`${styles.actBtn} ${styles.actConfirmBtn}`} disabled={confirming[r.routeId + 'ship']} title="Подтвердить отгрузку" onClick={e => { e.stopPropagation(); onConfirm(r.routeId, 'ship') }}>
            {confirming[r.routeId + 'ship'] ? '...' : 'Отгр.'}
          </button>
        : <span className={styles.actDone} title="Отгрузка подтверждена"><Check size={11} strokeWidth={2.5} /> Отгр.</span>)
    : null

  const recvConfirmEl = r.receiving
    ? (!r.receiving.confirmed
        ? <button className={`${styles.actBtn} ${styles.actConfirmBtn}`} disabled={confirming[r.routeId + 'receive']} title="Подтвердить приёмку" onClick={e => { e.stopPropagation(); onConfirm(r.routeId, 'receive') }}>
            {confirming[r.routeId + 'receive'] ? '...' : 'Пр.'}
          </button>
        : <span className={styles.actDone} title="Приёмка подтверждена"><Check size={11} strokeWidth={2.5} /> Пр.</span>)
    : null

  return (
    <>
      <tr
        className={`${styles.trMain} ${rowStatusClass}`}
        onClick={e => { if (!e.target.closest('[data-noexpand]')) onToggleExpand(r.routeId) }}
      >
        <td className={styles.tdCheck} data-noexpand="1" onClick={e => e.stopPropagation()}>
          <input type="checkbox" checked={selected} onChange={() => onToggleSelect(r.routeId)} />
        </td>
        <td>{fmtDate(r.date)}</td>
        <td className={styles.tdBold}>{r.routeNumber || '—'}</td>
        <td className={`${styles.tdMuted} ${styles.tdTrunc}`} title={r.driver?.name || ''}>{shortFio(r.driver?.name) || '—'}</td>
        <td className={`${styles.tdMuted} ${styles.tdTrunc}`} title={r.vehicle ? `${r.vehicle.model} ${r.vehicle.number}` : ''}>{r.vehicle ? `${r.vehicle.model} ${r.vehicle.number}` : '—'}</td>
        <td className={styles.tdMuted}>{r.cfzAddresses?.length ? `${r.cfzAddresses.length}` : '—'}</td>
        <td className={styles.tdNum}>{r.shippedRK != null ? r.shippedRK : <span className={styles.naVal}>—</span>}</td>
        <td className={styles.tdNum}>{r.shippedPallets != null && r.shippedPallets > 0 ? r.shippedPallets : <span className={styles.naVal}>—</span>}</td>
        <td className={styles.tdNum}>{r.shippedBoxes != null && r.shippedBoxes > 0 ? r.shippedBoxes : <span className={styles.naVal}>—</span>}</td>
        <td className={styles.tdNum}>{r.shippedThermalCovers != null && r.shippedThermalCovers > 0 ? r.shippedThermalCovers : <span className={styles.naVal}>—</span>}</td>
        <td className={styles.tdNum}>{r.shipment?.rokhlya != null ? r.shipment.rokhlya : <span className={styles.naVal}>—</span>}</td>
        <td className={`${styles.tdMuted} ${styles.tdTrunc}`} title={r.shipment?.by || ''}>{r.shipment?.by || '—'}</td>
        <td className={styles.tdNum}>{r.shipment?.tempBefore != null ? `${r.shipment.tempBefore}°` : '—'}</td>
        <td className={styles.tdNum}>{r.shipment?.tempAfter != null ? `${r.shipment.tempAfter}°` : '—'}</td>
        <td className={`${styles.tdMuted} ${styles.tdDate}`}>{fmtDateTime(r.shippedAt)}</td>
        <td className={styles.tdNum}>{r.receivedRK != null ? r.receivedRK : <span className={styles.naVal}>—</span>}</td>
        <td className={styles.tdNum}>{r.receivedPallets != null && r.receivedPallets > 0 ? r.receivedPallets : <span className={styles.naVal}>—</span>}</td>
        <td className={styles.tdNum}>{r.receivedBoxes != null && r.receivedBoxes > 0 ? r.receivedBoxes : <span className={styles.naVal}>—</span>}</td>
        <td className={styles.tdNum}>{r.receivedThermalCovers != null && r.receivedThermalCovers > 0 ? r.receivedThermalCovers : <span className={styles.naVal}>—</span>}</td>
        <td className={styles.tdNum}>{r.receiving?.rokhlya != null ? r.receiving.rokhlya : <span className={styles.naVal}>—</span>}</td>
        <td className={styles.tdNum}>{r.rokhlyaDebt != null && r.rokhlyaDebt !== 0 ? r.rokhlyaDebt : <span className={styles.naVal}>—</span>}</td>
        <td className={`${styles.tdMuted} ${styles.tdTrunc}`} title={r.receiving?.by || ''}>{r.receiving?.by || '—'}</td>
        <td className={`${styles.tdMuted} ${styles.tdDate}`}>{fmtDateTime(r.receivedAt)}</td>
        <td className={styles.tdNum}><DiffVal diff={r.diff} /></td>
        <td className={`${styles.tdMuted} ${styles.tdTrunc}`} title={r.shipment?.confirmedBy || ''}>{shortFio(r.shipment?.confirmedBy) || '—'}</td>
        <td className={`${styles.tdMuted} ${styles.tdTrunc}`} title={r.receiving?.confirmedBy || ''}>{shortFio(r.receiving?.confirmedBy) || '—'}</td>
        <td className={styles.tdActions} data-noexpand="1">
          {shipConfirmEl}
          {recvConfirmEl}
          <button className={`${styles.actBtn} ${styles.actEditBtn}`} title="Редактировать" onClick={e => { e.stopPropagation(); onEdit(r.routeId) }}><Pencil size={13} strokeWidth={2} /></button>
        </td>
      </tr>
      {expanded && <RouteDetailRow route={r} onLightbox={onLightbox} />}
    </>
  )
})

function RouteDetailRow({ route: r, onLightbox }) {
  const shipItems = r.shipment?.items || []
  const recvItems = r.receiving?.items || []
  const cfzList = r.cfzAddresses || []
  const addrs = useMemo(() => cfzList.length
    ? cfzList.map(a => a.address)
    : [...new Set([...shipItems.map(i => i.address), ...recvItems.map(i => i.address)])]
  , [cfzList, shipItems, recvItems])

  const meta = [
    r.shipment ? <>
      Отгрузил: <b>{r.shipment.by || '—'}</b>
      {r.shipment.gate ? <> · Ворота: <b>{r.shipment.gate}</b></> : ''}
      {r.shipment.tempBefore != null ? <> · Темп.до: <b>{r.shipment.tempBefore}°</b></> : ''}
      {r.shipment.tempAfter != null ? <> · Темп.после: <b>{r.shipment.tempAfter}°</b></> : ''}
      {r.shipment.rokhlya != null ? <> · Рохли: <b>{r.shipment.rokhlya}</b></> : ''}
      {r.shipment.confirmed ? <span className={styles.badgeOk}><Check size={11} strokeWidth={2.5} /></span> : ''}
    </> : null,
    r.receiving ? <>
      Принял: <b>{r.receiving.by || '—'}</b>
      {r.receiving.gate ? <> · Ворота: <b>{r.receiving.gate}</b></> : ''}
      {r.receiving.rokhlya != null ? <> · Рохли возвр.: <b>{r.receiving.rokhlya}</b></> : ''}
      {r.rokhlyaDebt != null && r.rokhlyaDebt !== 0 ? <> · Долг рохлей: <b style={{ color: '#e65100' }}>{r.rokhlyaDebt}</b></> : ''}
      {r.receiving.confirmed ? <span className={styles.badgeOk}><Check size={11} strokeWidth={2.5} /></span> : ''}
    </> : null,
  ].filter(Boolean)

  const shipPhotos = r.shipment?.photos || []
  const recvPhotos = r.receiving?.photos || []

  return (
    <tr>
      <td colSpan={99} style={{ padding: 0, borderBottom: 'none' }}>
        <div className={styles.detailBlock}>
          {meta.length > 0 && (
            <div className={styles.detailMeta}>
              {meta.map((m, i) => <span key={i}>{i > 0 ? ' · ' : ''}{m}</span>)}
            </div>
          )}
          {addrs.length > 0
            ? <table className={styles.detailTable}>
                <thead><tr>
                  <th>Адрес ЦФЗ</th>
                  <th className={styles.thNum}>РК отгр.</th>
                  <th className={styles.thNum}>Пал. отгр.</th>
                  <th className={styles.thNum}>Ящ. отгр.</th>
                  <th className={styles.thNum}>ТЧ отгр.</th>
                  <th className={styles.thNum}>РК прин.</th>
                  <th className={styles.thNum}>Пал. прин.</th>
                  <th className={styles.thNum}>Ящ. прин.</th>
                  <th className={styles.thNum}>ТЧ прин.</th>
                  <th className={styles.thNum}>Разница РК</th>
                </tr></thead>
                <tbody>
                  {addrs.map(addr => {
                    const s = shipItems.find(i => i.address === addr)
                    const rv = recvItems.find(i => i.address === addr)
                    const d = s && rv ? rv.rk - s.rk : null
                    return (
                      <tr key={addr}>
                        <td>{addr}</td>
                        <td className={styles.tdNum}>{s ? s.rk : <span className={styles.naVal}>—</span>}</td>
                        <td className={styles.tdNum}>{s?.pallets > 0 ? s.pallets : <span className={styles.naVal}>—</span>}</td>
                        <td className={styles.tdNum}>{s?.boxes > 0 ? s.boxes : <span className={styles.naVal}>—</span>}</td>
                        <td className={styles.tdNum}>{s?.thermalCovers > 0 ? s.thermalCovers : <span className={styles.naVal}>—</span>}</td>
                        <td className={styles.tdNum}>{rv ? rv.rk : <span className={styles.naVal}>—</span>}</td>
                        <td className={styles.tdNum}>{rv?.pallets > 0 ? rv.pallets : <span className={styles.naVal}>—</span>}</td>
                        <td className={styles.tdNum}>{rv?.boxes > 0 ? rv.boxes : <span className={styles.naVal}>—</span>}</td>
                        <td className={styles.tdNum}>{rv?.thermalCovers > 0 ? rv.thermalCovers : <span className={styles.naVal}>—</span>}</td>
                        <td className={styles.tdNum}><DiffVal diff={d} /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            : <div className={styles.empty}>Данные по ЦФЗ отсутствуют</div>
          }
          {(shipPhotos.length > 0 || recvPhotos.length > 0) && (
            <div className={styles.photoCols}>
              {shipPhotos.length > 0 && (
                <div className={styles.photoCol}>
                  <div className={styles.photoColLabel}>Отгрузил</div>
                  <div className={styles.photosRow}>
                    {shipPhotos.map((u, i) => (
                      <span key={u} className={styles.photoThumb} onClick={() => onLightbox(shipPhotos, i)}>
                        <img src={thumbUrl(u)} alt="фото" decoding="async" onError={e => { e.currentTarget.src = u }} />
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {recvPhotos.length > 0 && (
                <div className={styles.photoCol}>
                  <div className={styles.photoColLabel}>Принял</div>
                  <div className={styles.photosRow}>
                    {recvPhotos.map((u, i) => (
                      <span key={u} className={styles.photoThumb} onClick={() => onLightbox(recvPhotos, i)}>
                        <img src={thumbUrl(u)} alt="фото" decoding="async" onError={e => { e.currentTarget.src = u }} />
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </td>
    </tr>
  )
}

const MobileRouteCard = memo(function MobileRouteCard({ route: r, confirming, onConfirm, onEdit, onLightbox }) {
  const [expanded, setExpanded] = useState(false)

  const hasShipment = !!r.shipment
  const hasReceiving = !!r.receiving
  const shipConfirmed = !!r.shipment?.confirmed
  const recvConfirmed = !!r.receiving?.confirmed

  let statusLabel = 'Не отгружен'
  let statusClass = styles.mCardStatusNew
  if (hasShipment && !hasReceiving) { statusLabel = 'Ожидает приёмки'; statusClass = styles.mCardStatusPending }
  else if (hasShipment && hasReceiving && shipConfirmed && recvConfirmed) { statusLabel = 'Завершён'; statusClass = styles.mCardStatusDone }
  else if (hasShipment && hasReceiving) { statusLabel = 'Ждёт подтверждения'; statusClass = styles.mCardStatusAwait }

  const shipPhotos = r.shipment?.photos || []
  const recvPhotos = r.receiving?.photos || []

  return (
    <div className={styles.mCard}>
      <div className={styles.mCardTop} onClick={() => setExpanded(e => !e)}>
        <div>
          <div className={styles.mCardRoute}>{r.routeNumber || '—'}</div>
          <div className={styles.mCardDate}>{fmtDate(r.date)}</div>
        </div>
        <span className={`${styles.mCardStatus} ${statusClass}`}>{statusLabel}</span>
      </div>

      <div className={styles.mCardMeta} onClick={() => setExpanded(e => !e)}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Car size={13} strokeWidth={2} />{r.driver?.name || '—'}</span>
        {r.vehicle && <span>· {r.vehicle.number}</span>}
        {r.cfzAddresses?.length ? <span>· ЦФЗ: {r.cfzAddresses.length}</span> : null}
      </div>

      <div className={styles.mCardMetrics}>
        <div className={styles.mCardMetric}>
          <span className={styles.mCardMetricLabel}>Отгружено РК</span>
          <span className={styles.mCardMetricVal}>{r.shippedRK != null ? r.shippedRK : '—'}</span>
        </div>
        <div className={styles.mCardMetricDivider} />
        <div className={styles.mCardMetric}>
          <span className={styles.mCardMetricLabel}>Принято РК</span>
          <span className={styles.mCardMetricVal}>{r.receivedRK != null ? r.receivedRK : '—'}</span>
        </div>
        <div className={styles.mCardMetricDivider} />
        <div className={styles.mCardMetric}>
          <span className={styles.mCardMetricLabel}>Разница</span>
          <span className={styles.mCardMetricVal}><DiffVal diff={r.diff} /></span>
        </div>
      </div>

      {expanded && (
        <div className={styles.mCardDetail}>
          {r.shipment && (
            <div className={styles.mCardDetailRow}>
              <span className={styles.mCardDetailLabel}>Отгрузил</span>
              <span>{r.shipment.by || '—'}{r.shipment.gate ? `, ворота ${r.shipment.gate}` : ''}{r.shipment.tempBefore != null ? `, ${r.shipment.tempBefore}°→${r.shipment.tempAfter}°` : ''}</span>
            </div>
          )}
          {r.receiving && (
            <div className={styles.mCardDetailRow}>
              <span className={styles.mCardDetailLabel}>Принял</span>
              <span>{r.receiving.by || '—'}{r.receiving.gate ? `, ворота ${r.receiving.gate}` : ''}</span>
            </div>
          )}
          {r.cfzAddresses?.map(a => {
            const s = r.shipment?.items?.find(i => i.address === a.address)
            const rv = r.receiving?.items?.find(i => i.address === a.address)
            return (
              <div key={a.address} className={styles.mCardCfzRow}>
                <span className={styles.mCardCfzAddr}>{a.address}</span>
                <span className={styles.mCardCfzNums}>{s ? `↗${s.rk}` : '—'} / {rv ? `↙${rv.rk}` : '—'}</span>
              </div>
            )
          })}
          {(shipPhotos.length > 0 || recvPhotos.length > 0) && (
            <div className={styles.mCardPhotos}>
              {shipPhotos.map((u, i) => (
                <span key={u} className={styles.photoThumb} onClick={() => onLightbox(shipPhotos, i)}>
                  <img src={thumbUrl(u)} alt="фото" decoding="async" />
                </span>
              ))}
              {recvPhotos.map((u, i) => (
                <span key={u} className={styles.photoThumb} onClick={() => onLightbox(recvPhotos, i)}>
                  <img src={thumbUrl(u)} alt="фото" decoding="async" />
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className={styles.mCardActions}>
        {r.shipment && !r.shipment.confirmed && (
          <button className={`${styles.btn} ${styles.btnSm} ${styles.btnSecondary} ${styles.mCardActBtn}`} disabled={confirming[r.routeId + 'ship']} onClick={() => onConfirm(r.routeId, 'ship')}>
            <Check size={13} strokeWidth={2.5} />Отгрузка
          </button>
        )}
        {r.receiving && !r.receiving.confirmed && (
          <button className={`${styles.btn} ${styles.btnSm} ${styles.btnSecondary} ${styles.mCardActBtn}`} disabled={confirming[r.routeId + 'receive']} onClick={() => onConfirm(r.routeId, 'receive')}>
            <Check size={13} strokeWidth={2.5} />Приёмка
          </button>
        )}
        <button className={`${styles.btn} ${styles.btnSm} ${styles.btnSecondary} ${styles.mCardActBtn}`} onClick={() => onEdit(r.routeId)}><Pencil size={13} strokeWidth={2} />Изменить</button>
      </div>
    </div>
  )
})

// ─── Drivers view ─────────────────────────────────────────────────────────────

function DriversView({ data, loading, error }) {
  const [sort, setSort] = useLocalState('sh_classic_drivers_sort', { key: null, dir: null })
  const [detailSort, setDetailSort] = useState(new Map())
  const [expanded, setExpanded] = useState(new Set())

  const toggleExpand = id => setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleSort = col => setSort(s => toggleSortState(s, col))
  const toggleDetailSort = (owner, col) => {
    setDetailSort(m => {
      const n = new Map(m)
      const cur = n.get(owner) || { key: null, dir: null }
      n.set(owner, toggleSortState(cur, col))
      return n
    })
  }

  if (loading) return <div className={styles.loading}>Загрузка...</div>
  if (error)   return <div className={styles.error}>{error}</div>
  if (!data.length) return <div className={styles.empty}>Нет данных.</div>

  const sorted = sortedData(data, sort)

  return (
    <div>
      <div className={styles.mCardList}>
        {sorted.map(d => (
          <div key={d.name} className={styles.mCard}>
            <div className={styles.mCardTop} onClick={() => toggleExpand(d.name)}>
              <div>
                <div className={styles.mCardRoute}>{d.name}</div>
                {d.phone ? <div className={styles.mCardDate}>{d.phone}</div> : null}
              </div>
              <span className={styles.mCardStatus} style={{ background: '#F5F7FA', color: '#6B7280' }}>{d.routeCount} марш.</span>
            </div>
            <div className={styles.mCardMetrics}>
              <div className={styles.mCardMetric}>
                <span className={styles.mCardMetricLabel}>РК отгр.</span>
                <span className={styles.mCardMetricVal}>{d.shippedTotal || 0}</span>
              </div>
              <div className={styles.mCardMetricDivider} />
              <div className={styles.mCardMetric}>
                <span className={styles.mCardMetricLabel}>РК прин.</span>
                <span className={styles.mCardMetricVal}>{d.receivedTotal || 0}</span>
              </div>
              <div className={styles.mCardMetricDivider} />
              <div className={styles.mCardMetric}>
                <span className={styles.mCardMetricLabel}>Разница</span>
                <span className={styles.mCardMetricVal}><DiffVal diff={d.diff} /></span>
              </div>
              {d.rokhlyaDebt != null && d.rokhlyaDebt !== 0 && (() => {
                const debtRoute = (d.routes || []).filter(r => (r.shippedRokhlya - r.receivedRokhlya) > 0).sort((a, b) => a.date.localeCompare(b.date))[0] || null
                return <>
                  <div className={styles.mCardMetricDivider} />
                  <div className={styles.mCardMetric}>
                    <span className={styles.mCardMetricLabel}>Долг рохлей</span>
                    <span className={styles.mCardMetricVal} style={{ color: d.rokhlyaDebt > 0 ? '#e65100' : '#388e3c' }}>
                      {d.rokhlyaDebt}
                      {debtRoute && <span style={{ fontSize: 11, fontWeight: 400, display: 'block', color: '#e65100' }}>с {fmtDate(debtRoute.date)} · {debtRoute.routeNumber}</span>}
                    </span>
                  </div>
                </>
              })()}
            </div>
            {expanded.has(d.name) && (
              <div className={styles.mCardDetail}>
                {(d.routes || []).map(r => (
                  <div key={r.routeId} className={styles.mCardCfzRow}>
                    <span className={styles.mCardCfzAddr}>{r.routeNumber} · {fmtDate(r.date)}</span>
                    <span className={styles.mCardCfzNums}>↗{r.shippedRK ?? '—'} / ↙{r.receivedRK ?? '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className={styles.desktopOnly}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Водитель</th>
              {['routeCount', 'shippedTotal', 'shippedPallets', 'shippedBoxes', 'shippedThermalCovers', 'shippedRokhlya', 'receivedTotal', 'receivedPallets', 'receivedBoxes', 'receivedThermalCovers', 'receivedRokhlya', 'rokhlyaDebt', 'diff'].map(col => (
                <th key={col} className={`${styles.thNum} ${styles.thSort}`} onClick={() => toggleSort(col)}>
                  {{ routeCount: 'Маршрутов', shippedTotal: 'РК отгр.', shippedPallets: 'Пал. отгр.', shippedBoxes: 'Ящ. отгр.', shippedThermalCovers: 'ТЧ отгр.', shippedRokhlya: 'Рохли↗', receivedTotal: 'РК прин.', receivedPallets: 'Пал. прин.', receivedBoxes: 'Ящ. прин.', receivedThermalCovers: 'ТЧ прин.', receivedRokhlya: 'Рохли↙', rokhlyaDebt: 'Долг рохлей', diff: 'Разница РК' }[col]}
                  {' '}<SortArrow sort={sort} col={col} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map(d => (
              <DriverRows
                key={d.name}
                driver={d}
                expanded={expanded.has(d.name)}
                detailSort={detailSort.get(d.name) || { key: null, dir: null }}
                onToggle={() => toggleExpand(d.name)}
                onDetailSort={col => toggleDetailSort(d.name, col)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function DriverRows({ driver: d, expanded, detailSort: ds, onToggle, onDetailSort }) {
  return (
    <>
      <tr className={styles.trMain} onClick={onToggle}>
        <td className={styles.tdBold}>{d.name}</td>
        <td className={styles.tdNum}>{d.routeCount}</td>
        <td className={styles.tdNum}>{d.shippedTotal || 0}</td>
        <td className={styles.tdNum}>{d.shippedPallets || 0}</td>
        <td className={styles.tdNum}>{d.shippedBoxes || 0}</td>
        <td className={styles.tdNum}>{d.shippedThermalCovers || 0}</td>
        <td className={styles.tdNum}>{d.shippedRokhlya || 0}</td>
        <td className={styles.tdNum}>{d.receivedTotal || 0}</td>
        <td className={styles.tdNum}>{d.receivedPallets || 0}</td>
        <td className={styles.tdNum}>{d.receivedBoxes || 0}</td>
        <td className={styles.tdNum}>{d.receivedThermalCovers || 0}</td>
        <td className={styles.tdNum}>{d.receivedRokhlya || 0}</td>
        <td className={styles.tdNum}>{d.rokhlyaDebt != null && d.rokhlyaDebt !== 0 ? (() => {
          const debtRoute = (d.routes || []).filter(r => (r.shippedRokhlya - r.receivedRokhlya) > 0).sort((a, b) => a.date.localeCompare(b.date))[0] || null
          return <span style={{ color: d.rokhlyaDebt > 0 ? '#e65100' : '#388e3c', fontWeight: 600 }}>
            {d.rokhlyaDebt}
            {debtRoute && <span style={{ fontSize: 11, fontWeight: 400, display: 'block' }}>с {fmtDate(debtRoute.date)}<br />{debtRoute.routeNumber}</span>}
          </span>
        })() : <span className={styles.naVal}>—</span>}</td>
        <td className={styles.tdNum}><DiffVal diff={d.diff} /></td>
      </tr>
      {expanded && <DriverDetailRow driver={d} detailSort={ds} onDetailSort={onDetailSort} />}
    </>
  )
}

function DriverDetailRow({ driver: d, detailSort: ds, onDetailSort }) {
  const cfzMap = new Map()
  for (const route of d.routes || []) {
    for (const { address } of route.cfzAddresses || []) {
      if (!address) continue
      if (!cfzMap.has(address)) cfzMap.set(address, { address, routeCount: 0, shipped: 0, received: 0, shippedPallets: 0, receivedPallets: 0 })
      const e = cfzMap.get(address)
      e.routeCount++
      if (route.shippedRK != null) e.shipped += route.shippedRK
      if (route.receivedRK != null) e.received += route.receivedRK
      if (route.shippedPallets != null) e.shippedPallets += route.shippedPallets
      if (route.receivedPallets != null) e.receivedPallets += route.receivedPallets
    }
  }
  let cfzList = Array.from(cfzMap.values()).map(e => ({ ...e, diff: (e.shipped > 0 || e.received > 0) ? e.received - e.shipped : null }))
  if (ds.key && ds.dir) {
    cfzList = cfzList.sort((a, b) => { const av = a[ds.key] ?? 0, bv = b[ds.key] ?? 0; return ds.dir === 'desc' ? bv - av : av - bv })
  } else {
    cfzList.sort((a, b) => a.address.localeCompare(b.address, 'ru'))
  }

  return (
    <tr>
      <td colSpan={14} style={{ padding: 0 }}>
        <div className={styles.detailBlock}>
          {cfzList.length > 0
            ? <table className={styles.detailTable}>
                <thead>
                  <tr>
                    <th>Адрес ЦФЗ</th>
                    {['routeCount', 'shipped', 'received', 'diff'].map(col => (
                      <th key={col} className={`${styles.thNum} ${styles.thSort}`} onClick={() => onDetailSort(col)}>
                        {{ routeCount: 'Маршрутов', shipped: 'Отгружено', received: 'Принято', diff: 'Разница' }[col]}
                        {' '}<SortArrow sort={ds} col={col} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cfzList.map(e => (
                    <tr key={e.address}>
                      <td>{e.address}</td>
                      <td className={styles.tdNum}>{e.routeCount}</td>
                      <td className={styles.tdNum}>{e.shipped}</td>
                      <td className={styles.tdNum}>{e.received}</td>
                      <td className={styles.tdNum}><DiffVal diff={e.diff} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            : <div className={styles.empty}>Адреса ЦФЗ не указаны в маршрутах этого водителя</div>
          }
        </div>
      </td>
    </tr>
  )
}

// ─── CFZ view ─────────────────────────────────────────────────────────────────

function CfzView({ data, loading, error }) {
  const [sort, setSort] = useLocalState('sh_classic_cfz_sort', { key: null, dir: null })
  const [detailSort, setDetailSort] = useState(new Map())
  const [expanded, setExpanded] = useState(new Set())

  const toggleExpand = id => setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleSort = col => setSort(s => toggleSortState(s, col))
  const toggleDetailSort = (owner, col) => {
    setDetailSort(m => {
      const n = new Map(m)
      const cur = n.get(owner) || { key: null, dir: null }
      n.set(owner, toggleSortState(cur, col))
      return n
    })
  }

  if (loading) return <div className={styles.loading}>Загрузка...</div>
  if (error)   return <div className={styles.error}>{error}</div>
  if (!data.length) return <div className={styles.empty}>Нет данных.</div>

  const sorted = sortedData(data, sort)

  return (
    <div>
      <div className={styles.mCardList}>
        {sorted.map(entry => (
          <div key={entry.address} className={styles.mCard}>
            <div className={styles.mCardTop} onClick={() => toggleExpand(entry.address)}>
              <div>
                <div className={styles.mCardRoute} style={{ fontSize: 13 }}>{entry.address}</div>
              </div>
              <span className={styles.mCardStatus} style={{ background: '#F5F7FA', color: '#6B7280' }}>{entry.routeCount} марш.</span>
            </div>
            <div className={styles.mCardMetrics}>
              <div className={styles.mCardMetric}>
                <span className={styles.mCardMetricLabel}>РК отгр.</span>
                <span className={styles.mCardMetricVal}>{entry.shippedTotal || 0}</span>
              </div>
              <div className={styles.mCardMetricDivider} />
              <div className={styles.mCardMetric}>
                <span className={styles.mCardMetricLabel}>РК прин.</span>
                <span className={styles.mCardMetricVal}>{entry.receivedTotal || 0}</span>
              </div>
              <div className={styles.mCardMetricDivider} />
              <div className={styles.mCardMetric}>
                <span className={styles.mCardMetricLabel}>Разница</span>
                <span className={styles.mCardMetricVal}><DiffVal diff={entry.diff} /></span>
              </div>
            </div>
            {expanded.has(entry.address) && (
              <div className={styles.mCardDetail}>
                {(entry.routes || []).map(r => (
                  <div key={r.routeId} className={styles.mCardCfzRow}>
                    <span className={styles.mCardCfzAddr}>{r.routeNumber} · {fmtDate(r.date)} · {shortFio(r.driver?.name)}</span>
                    <span className={styles.mCardCfzNums}>↗{r.shippedRK ?? '—'} / ↙{r.receivedRK ?? '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className={styles.desktopOnly}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Адрес ЦФЗ</th>
              {['routeCount', 'shippedTotal', 'shippedPallets', 'shippedBoxes', 'shippedThermalCovers', 'receivedTotal', 'receivedPallets', 'receivedBoxes', 'receivedThermalCovers', 'diff'].map(col => (
                <th key={col} className={`${styles.thNum} ${styles.thSort}`} onClick={() => toggleSort(col)}>
                  {{ routeCount: 'Маршрутов', shippedTotal: 'РК отгр.', shippedPallets: 'Пал. отгр.', shippedBoxes: 'Ящ. отгр.', shippedThermalCovers: 'ТЧ отгр.', receivedTotal: 'РК прин.', receivedPallets: 'Пал. прин.', receivedBoxes: 'Ящ. прин.', receivedThermalCovers: 'ТЧ прин.', diff: 'Разница' }[col]}
                  {' '}<SortArrow sort={sort} col={col} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map(entry => (
              <CfzRows
                key={entry.address}
                entry={entry}
                expanded={expanded.has(entry.address)}
                detailSort={detailSort.get(entry.address) || { key: null, dir: null }}
                onToggle={() => toggleExpand(entry.address)}
                onDetailSort={col => toggleDetailSort(entry.address, col)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function CfzRows({ entry, expanded, detailSort: ds, onToggle, onDetailSort }) {
  return (
    <>
      <tr className={styles.trMain} onClick={onToggle}>
        <td className={styles.tdBold}>{entry.address}</td>
        <td className={styles.tdNum}>{entry.routeCount}</td>
        <td className={styles.tdNum}>{entry.shippedTotal || 0}</td>
        <td className={styles.tdNum}>{entry.shippedPallets || 0}</td>
        <td className={styles.tdNum}>{entry.shippedBoxes || 0}</td>
        <td className={styles.tdNum}>{entry.shippedThermalCovers || 0}</td>
        <td className={styles.tdNum}>{entry.receivedTotal || 0}</td>
        <td className={styles.tdNum}>{entry.receivedPallets || 0}</td>
        <td className={styles.tdNum}>{entry.receivedBoxes || 0}</td>
        <td className={styles.tdNum}>{entry.receivedThermalCovers || 0}</td>
        <td className={styles.tdNum}><DiffVal diff={entry.diff} /></td>
      </tr>
      {expanded && <CfzDetailRow entry={entry} detailSort={ds} onDetailSort={onDetailSort} />}
    </>
  )
}

function CfzDetailRow({ entry, detailSort: ds, onDetailSort }) {
  let routes = [...(entry.routes || [])]
  if (ds.key && ds.dir) {
    routes.sort((a, b) => {
      if (ds.key === 'date') { const av = a.date || '', bv = b.date || ''; return ds.dir === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv) }
      const av = a[ds.key] ?? 0, bv = b[ds.key] ?? 0
      return ds.dir === 'desc' ? bv - av : av - bv
    })
  }

  return (
    <tr>
      <td colSpan={11} style={{ padding: 0 }}>
        <div className={styles.detailBlock}>
          {routes.length > 0
            ? <table className={styles.detailTable}>
                <thead>
                  <tr>
                    <th className={styles.thSort} onClick={() => onDetailSort('date')}>Дата <SortArrow sort={ds} col="date" /></th>
                    <th>Маршрут</th><th>Водитель</th>
                    <th className={`${styles.thNum} ${styles.thSort}`} onClick={() => onDetailSort('shippedRK')}>РК отгр. <SortArrow sort={ds} col="shippedRK" /></th>
                    <th className={styles.thNum}>Пал. отгр.</th>
                    <th className={styles.thNum}>Ящ. отгр.</th>
                    <th className={styles.thNum}>ТЧ отгр.</th>
                    <th className={styles.thNum}>Дата отгр.</th>
                    <th className={`${styles.thNum} ${styles.thSort}`} onClick={() => onDetailSort('receivedRK')}>РК прин. <SortArrow sort={ds} col="receivedRK" /></th>
                    <th className={styles.thNum}>Пал. прин.</th>
                    <th className={styles.thNum}>Ящ. прин.</th>
                    <th className={styles.thNum}>ТЧ прин.</th>
                    <th className={styles.thNum}>Дата прин.</th>
                    <th className={`${styles.thNum} ${styles.thSort}`} onClick={() => onDetailSort('diff')}>Разница <SortArrow sort={ds} col="diff" /></th>
                  </tr>
                </thead>
                <tbody>
                  {routes.map(r => (
                    <tr key={r.routeId}>
                      <td>{fmtDate(r.date)}</td>
                      <td>{r.routeNumber || '—'}</td>
                      <td title={r.driver?.name || ''}>{shortFio(r.driver?.name) || '—'}</td>
                      <td className={styles.tdNum}>{r.shippedRK != null ? r.shippedRK : <span className={styles.naVal}>—</span>}</td>
                      <td className={styles.tdNum}>{r.shippedPallets > 0 ? r.shippedPallets : <span className={styles.naVal}>—</span>}</td>
                      <td className={styles.tdNum}>{r.shippedBoxes > 0 ? r.shippedBoxes : <span className={styles.naVal}>—</span>}</td>
                      <td className={styles.tdNum}>{r.shippedThermalCovers > 0 ? r.shippedThermalCovers : <span className={styles.naVal}>—</span>}</td>
                      <td className={`${styles.tdMuted} ${styles.tdDate}`}>{fmtDateTime(r.shippedAt)}</td>
                      <td className={styles.tdNum}>{r.receivedRK != null ? r.receivedRK : <span className={styles.naVal}>—</span>}</td>
                      <td className={styles.tdNum}>{r.receivedPallets > 0 ? r.receivedPallets : <span className={styles.naVal}>—</span>}</td>
                      <td className={styles.tdNum}>{r.receivedBoxes > 0 ? r.receivedBoxes : <span className={styles.naVal}>—</span>}</td>
                      <td className={styles.tdNum}>{r.receivedThermalCovers > 0 ? r.receivedThermalCovers : <span className={styles.naVal}>—</span>}</td>
                      <td className={`${styles.tdMuted} ${styles.tdDate}`}>{fmtDateTime(r.receivedAt)}</td>
                      <td className={styles.tdNum}><DiffVal diff={r.diff} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            : <div className={styles.empty}>Маршруты не найдены</div>
          }
        </div>
      </td>
    </tr>
  )
}

// ─── Классическая форма редактирования маршрута ────────────────────────────────
// Визуально — оригинальный FormStep4Edit (модалка `position:fixed`, разделы
// «Отгрузка»/«Приёмка» с рамкой, РК/пал./ящ./ТЧ по ЦФЗ в один ряд, фото снизу
// каждого раздела). Логика сохранения — та же, что и в EditRouteDialog.jsx
// нового дизайна (обычный React state вместо document.getElementById/
// querySelectorAll оригинала — там это была фрагильность без выгоды, ради
// визуального сходства её незачем тащить обратно).

function itemsToMap(items) {
  const map = {}
  for (const it of items || []) map[it.address] = it
  return map
}

function ClassicPhotoBlock({ state, onRemoveExisting, onRemoveNew, onAddNew }) {
  return (
    <div className={styles.formPhotoSection}>
      <div className={styles.photoPreviewRow}>
        {state.existingPhotos.map((u, i) => (
          <div key={`e-${i}`} className={styles.photoPreviewItem}>
            <a href={u} target="_blank" rel="noreferrer"><img src={u} className={styles.photoThumbImg} alt="фото" /></a>
            <button type="button" className={styles.photoRemoveBtn} onClick={() => onRemoveExisting(i)}><X size={13} strokeWidth={2} /></button>
          </div>
        ))}
        {state.newPhotos.map((f, i) => (
          <div key={`n-${i}`} className={styles.photoPreviewItem}>
            <img src={URL.createObjectURL(f)} className={styles.photoThumbImg} alt="" />
            <button type="button" className={styles.photoRemoveBtn} onClick={() => onRemoveNew(i)}><X size={13} strokeWidth={2} /></button>
          </div>
        ))}
      </div>
      <label className={styles.photoUploadLabel} style={{ marginTop: 4 }}>
        <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => onAddNew(e.target.files)} />
        <span className={`${styles.btn} ${styles.btnSm} ${styles.btnSecondary}`}><Camera size={13} strokeWidth={2} />Добавить фото</span>
      </label>
    </div>
  )
}

function ClassicCfzRows({ cfzList, itemsState, setItemsState, hintMap }) {
  const setField = (address, field, value) => setItemsState(prev => ({ ...prev, [address]: { ...prev[address], [field]: value } }))

  if (!cfzList.length) return <div className={styles.empty}>ЦФЗ не указаны</div>

  return cfzList.map(a => {
    const cur = itemsState[a.address] || {}
    const hint = hintMap?.[a.address]
    return (
      <div key={a.address} className={styles.formCfzRow}>
        <span className={styles.formCfzAddr}>{a.address}</span>
        {hint && (
          <span className={styles.formCfzHint}>
            отгр: {hint.rk ?? 0} РК{hint.pallets ? ` / ${hint.pallets} пал.` : ''}{hint.boxes ? ` / ${hint.boxes} ящ.` : ''}{hint.thermalCovers ? ` / ${hint.thermalCovers} ТЧ` : ''}
          </span>
        )}
        <input type="number" className={`${styles.shInput} ${styles.inputRk}`} min="0" placeholder="РК" value={cur.rk ?? ''} onChange={e => setField(a.address, 'rk', e.target.value)} />
        <input type="number" className={`${styles.shInput} ${styles.inputRk}`} min="0" placeholder="пал." value={cur.pallets ?? ''} onChange={e => setField(a.address, 'pallets', e.target.value)} />
        <input type="number" className={`${styles.shInput} ${styles.inputRk}`} min="0" placeholder="ящ." value={cur.boxes ?? ''} onChange={e => setField(a.address, 'boxes', e.target.value)} />
        <input type="number" className={`${styles.shInput} ${styles.inputRk}`} min="0" placeholder="ТЧ" value={cur.thermalCovers ?? ''} onChange={e => setField(a.address, 'thermalCovers', e.target.value)} />
      </div>
    )
  })
}

function ClassicEditModal({ route, onClose, onSaved }) {
  const [driverName, setDriverName] = useState('')
  const [shipBy, setShipBy] = useState('')
  const [shipGate, setShipGate] = useState('')
  const [shipTempBefore, setShipTempBefore] = useState('')
  const [shipTempAfter, setShipTempAfter] = useState('')
  const [shipRokhlya, setShipRokhlya] = useState('')
  const [recvBy, setRecvBy] = useState('')
  const [recvGate, setRecvGate] = useState('')
  const [recvRokhlya, setRecvRokhlya] = useState('')
  const [shipItems, setShipItems] = useState({})
  const [recvItems, setRecvItems] = useState({})
  const [shipPhotos, setShipPhotos] = useState({ existingPhotos: [], newPhotos: [] })
  const [recvPhotos, setRecvPhotos] = useState({ existingPhotos: [], newPhotos: [] })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [mdOnBg, setMdOnBg] = useState(false)

  useEffect(() => {
    if (!route) return
    setDriverName(route.driver?.name || '')
    setShipBy(route.shipment?.by || '')
    setShipGate(route.shipment?.gate || '')
    setShipTempBefore(route.shipment?.tempBefore ?? '')
    setShipTempAfter(route.shipment?.tempAfter ?? '')
    setShipRokhlya(route.shipment?.rokhlya ?? '')
    setRecvBy(route.receiving?.by || '')
    setRecvGate(route.receiving?.gate || '')
    setRecvRokhlya(route.receiving?.rokhlya ?? '')
    setShipItems(itemsToMap(route.shipment?.items))
    setRecvItems(itemsToMap(route.receiving?.items))
    setShipPhotos({ existingPhotos: [...(route.shipment?.photos || [])], newPhotos: [] })
    setRecvPhotos({ existingPhotos: [...(route.receiving?.photos || [])], newPhotos: [] })
    setFormError('')
  }, [route])

  if (!route) return null
  const cfzList = route.cfzAddresses || []

  const collectItems = state => cfzList
    .map(a => {
      const cur = state[a.address]
      const rk = cur?.rk
      if (rk === '' || rk == null) return null
      return {
        address: a.address,
        rk: Number(rk) || 0,
        pallets: Number(cur.pallets) || 0,
        boxes: Number(cur.boxes) || 0,
        thermalCovers: Number(cur.thermalCovers) || 0,
      }
    })
    .filter(Boolean)

  const handleSave = async () => {
    setSaving(true)
    setFormError('')
    try {
      let shipPhotoUrls = [...shipPhotos.existingPhotos]
      if (shipPhotos.newPhotos.length) {
        const r = await api.uploadRkPhotos(shipPhotos.newPhotos)
        if (r.ok) shipPhotoUrls = [...shipPhotoUrls, ...r.urls]
      }
      let recvPhotoUrls = [...recvPhotos.existingPhotos]
      if (recvPhotos.newPhotos.length) {
        const r = await api.uploadRkPhotos(recvPhotos.newPhotos)
        if (r.ok) recvPhotoUrls = [...recvPhotoUrls, ...r.urls]
      }

      const shipPayload = { by: shipBy, gate: shipGate, tempBefore: shipTempBefore === '' ? null : Number(shipTempBefore), tempAfter: shipTempAfter === '' ? null : Number(shipTempAfter), rokhlya: shipRokhlya === '' ? null : Number(shipRokhlya), items: collectItems(shipItems), photos: shipPhotoUrls }
      const recvPayload = { by: recvBy, gate: recvGate, rokhlya: recvRokhlya === '' ? null : Number(recvRokhlya), items: collectItems(recvItems), photos: recvPhotoUrls }

      let lastRoute = null
      if (driverName.trim() !== (route.driver?.name || '')) {
        const r = await api.updateRkDriver(route.routeId, { name: driverName.trim() })
        if (r.ok) lastRoute = r.route
      }
      if (route.shipment || shipPayload.items.length) {
        const r = await api.updateRkShipment(route.routeId, shipPayload)
        if (r.ok) lastRoute = r.route
      }
      if (route.receiving || recvPayload.items.length) {
        const r = await api.updateRkReceiving(route.routeId, recvPayload)
        if (r.ok) lastRoute = r.route
      }
      if (lastRoute) onSaved(route.routeId, lastRoute)
      toast.success('Маршрут сохранён')
      onClose()
    } catch (err) {
      setFormError('Ошибка: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className={styles.modalOverlay}
      onMouseDown={e => setMdOnBg(e.target === e.currentTarget)}
      onClick={e => { if (e.target === e.currentTarget && mdOnBg) onClose() }}
    >
      <div className={`${styles.modalBox} ${styles.modalBoxLg}`}>
        <div className={styles.modalHeader}>
          <span>Редактировать маршрут</span>
          <button className={styles.modalClose} onClick={onClose}><X size={16} strokeWidth={2} /></button>
        </div>

        <div className={styles.formRouteSummary}>
          <span className={styles.formRouteNum}>{route.routeNumber || '—'}</span>
          <span className={styles.formRouteDate}>{fmtDate(route.date)}</span>
        </div>

        <label className={styles.formLabel}>
          Водитель
          <input type="text" className={styles.shInput} placeholder="Фамилия И.О." value={driverName} onChange={e => setDriverName(e.target.value)} />
        </label>

        <div className={styles.editSection}>
          <div className={styles.editSectionHdr}>
            <Truck size={14} strokeWidth={2} style={{ marginRight: 5 }} />Отгрузка
            {route.shipment?.confirmed ? <span className={styles.badgeOk}><Check size={12} strokeWidth={2.5} /></span> : ''}
          </div>
          <div className={styles.editRow2}>
            <label className={`${styles.formLabel} ${styles.editLabelWide}`}>Кладовщик<input type="text" className={styles.shInput} value={shipBy} onChange={e => setShipBy(e.target.value)} placeholder="Иванов И.И." /></label>
            <label className={styles.formLabel}>Ворота<input type="text" className={`${styles.shInput} ${styles.inputSm}`} value={shipGate} onChange={e => setShipGate(e.target.value)} placeholder="№" /></label>
          </div>
          <div className={styles.editRow2}>
            <label className={styles.formLabel}>Темп. до (°C)<input type="number" className={`${styles.shInput} ${styles.inputSm}`} value={shipTempBefore} onChange={e => setShipTempBefore(e.target.value)} placeholder="-18" /></label>
            <label className={styles.formLabel}>Темп. после (°C)<input type="number" className={`${styles.shInput} ${styles.inputSm}`} value={shipTempAfter} onChange={e => setShipTempAfter(e.target.value)} placeholder="-18" /></label>
            <label className={styles.formLabel}>Рохли (отд.)<input type="number" className={`${styles.shInput} ${styles.inputSm}`} min="0" value={shipRokhlya} onChange={e => setShipRokhlya(e.target.value)} placeholder="0" /></label>
          </div>
          <div className={styles.formCfzSection}>
            <div className={styles.formSectionTitle}>РК по ЦФЗ <span className={styles.hintClear}>(оставьте пустым — запись удалится)</span></div>
            <ClassicCfzRows cfzList={cfzList} itemsState={shipItems} setItemsState={setShipItems} />
          </div>
          <ClassicPhotoBlock
            state={shipPhotos}
            onRemoveExisting={i => setShipPhotos(prev => ({ ...prev, existingPhotos: prev.existingPhotos.filter((_, idx) => idx !== i) }))}
            onRemoveNew={i => setShipPhotos(prev => ({ ...prev, newPhotos: prev.newPhotos.filter((_, idx) => idx !== i) }))}
            onAddNew={files => setShipPhotos(prev => ({ ...prev, newPhotos: [...prev.newPhotos, ...Array.from(files)] }))}
          />
        </div>

        <div className={styles.editSection}>
          <div className={styles.editSectionHdr}>
            <PackageOpen size={14} strokeWidth={2} style={{ marginRight: 5 }} />Приёмка
            {route.receiving?.confirmed ? <span className={styles.badgeOk}><Check size={12} strokeWidth={2.5} /></span> : ''}
          </div>
          <div className={styles.editRow2}>
            <label className={`${styles.formLabel} ${styles.editLabelWide}`}>Кладовщик<input type="text" className={styles.shInput} value={recvBy} onChange={e => setRecvBy(e.target.value)} placeholder="Иванов И.И." /></label>
            <label className={styles.formLabel}>Ворота<input type="text" className={`${styles.shInput} ${styles.inputSm}`} value={recvGate} onChange={e => setRecvGate(e.target.value)} placeholder="№" /></label>
            <label className={styles.formLabel}>Рохли (возвр.)<input type="number" className={`${styles.shInput} ${styles.inputSm}`} min="0" value={recvRokhlya} onChange={e => setRecvRokhlya(e.target.value)} placeholder="0" /></label>
          </div>
          <div className={styles.formCfzSection}>
            <div className={styles.formSectionTitle}>РК по ЦФЗ <span className={styles.hintClear}>(оставьте пустым — запись удалится)</span></div>
            <ClassicCfzRows cfzList={cfzList} itemsState={recvItems} setItemsState={setRecvItems} hintMap={shipItems} />
          </div>
          <ClassicPhotoBlock
            state={recvPhotos}
            onRemoveExisting={i => setRecvPhotos(prev => ({ ...prev, existingPhotos: prev.existingPhotos.filter((_, idx) => idx !== i) }))}
            onRemoveNew={i => setRecvPhotos(prev => ({ ...prev, newPhotos: prev.newPhotos.filter((_, idx) => idx !== i) }))}
            onAddNew={files => setRecvPhotos(prev => ({ ...prev, newPhotos: [...prev.newPhotos, ...Array.from(files)] }))}
          />
        </div>

        <div className={styles.formError}>{formError}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={onClose}>Отмена</button>
          <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={saving} onClick={handleSave}>Сохранить</button>
        </div>
      </div>
    </div>
  )
}

// ─── Главный компонент ──────────────────────────────────────────────────────

export default function ShipmentsPageClassic() {
  const [activeView, setActiveView] = useLocalState('sh_classic_activeView', 'routes')

  const [routesData, setRoutesData] = useState([])
  const [driversData, setDriversData] = useState([])
  const [cfzData, setCfzData] = useState([])

  const [routesLoading, setRoutesLoading] = useState(false)
  const [driversLoading, setDriversLoading] = useState(false)
  const [cfzLoading, setCfzLoading] = useState(false)

  const [routesError, setRoutesError] = useState('')
  const [driversError, setDriversError] = useState('')
  const [cfzError, setCfzError] = useState('')

  const [routesStatusFilter, setRoutesStatusFilter] = useLocalState('sh_classic_statusFilter', 'all')
  const [routesDateFrom, setRoutesDateFrom] = useLocalState('sh_classic_dateFrom', '')
  const [routesDateTo, setRoutesDateTo] = useLocalState('sh_classic_dateTo', '')
  const [routesSearch, setRoutesSearch] = useLocalState('sh_classic_routesSearch', '')
  const [driversSearch, setDriversSearch] = useLocalState('sh_classic_driversSearch', '')
  const [cfzSearch, setCfzSearch] = useLocalState('sh_classic_cfzSearch', '')

  const [fetchModalOpen, setFetchModalOpen] = useState(false)
  const [reportModalOpen, setReportModalOpen] = useState(false)
  const [editRouteId, setEditRouteId] = useState(null)
  const [lightbox, setLightbox] = useState(null)

  const loadRoutes = useCallback(async q => {
    setRoutesLoading(true); setRoutesError('')
    try { setRoutesData(await api.getRkRoutes({ q })) }
    catch (err) { setRoutesError(err.message) }
    finally { setRoutesLoading(false) }
  }, [])

  const loadDrivers = useCallback(async q => {
    setDriversLoading(true); setDriversError('')
    try { setDriversData(await api.getRkDrivers(q)) }
    catch (err) { setDriversError(err.message) }
    finally { setDriversLoading(false) }
  }, [])

  const loadCfz = useCallback(async q => {
    setCfzLoading(true); setCfzError('')
    try { setCfzData(await api.getRkCfz(q)) }
    catch (err) { setCfzError(err.message) }
    finally { setCfzLoading(false) }
  }, [])

  useEffect(() => { loadRoutes('') }, [loadRoutes])

  useEffect(() => {
    const t = setTimeout(() => { if (activeView === 'routes') loadRoutes(routesSearch) }, 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routesSearch])

  useEffect(() => {
    const t = setTimeout(() => { if (activeView === 'drivers') loadDrivers(driversSearch) }, 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driversSearch])

  useEffect(() => {
    const t = setTimeout(() => { if (activeView === 'cfz') loadCfz(cfzSearch) }, 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfzSearch])

  const switchView = view => {
    setActiveView(view)
    if (view === 'routes') loadRoutes(routesSearch)
    if (view === 'drivers') loadDrivers(driversSearch)
    if (view === 'cfz') loadCfz(cfzSearch)
  }

  const handleRouteUpdate = useCallback((routeId, newRoute) => {
    setRoutesData(prev => prev.map(r => r.routeId === routeId ? newRoute : r))
  }, [])

  const handleBulkDelete = useCallback(ids => {
    const idSet = new Set(ids)
    setRoutesData(prev => prev.filter(r => !idSet.has(r.routeId)))
  }, [])

  const openLightbox = useCallback((photos, idx) => setLightbox({ photos, idx }), [])

  const filteredRoutesData = useMemo(() => routesData.filter(r => {
    if (routesStatusFilter === 'shipped') { if (!r.shipment) return false }
    else if (routesStatusFilter === 'received') { if (!r.receiving) return false }
    else if (routesStatusFilter === 'unconfirmed') { if (!((r.shipment && !r.shipment.confirmed) || (r.receiving && !r.receiving.confirmed))) return false }
    else if (routesStatusFilter === 'pending') { if (r.shipment || r.receiving) return false }
    if (routesDateFrom && r.date && r.date < routesDateFrom) return false
    if (routesDateTo && r.date && r.date > routesDateTo) return false
    return true
  }), [routesData, routesStatusFilter, routesDateFrom, routesDateTo])

  const editRoute = editRouteId ? routesData.find(r => r.routeId === editRouteId) || null : null

  return (
    <div className={styles.mainContent}>
      <div className={styles.toolbar}>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setHash('receive')} title="Форма отгрузки/приёмки — киоск для кладовщика на складе">
          <PackageOpen size={14} strokeWidth={2} />Форма отгрузки
        </button>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setFetchModalOpen(true)}>
          <Download size={14} strokeWidth={2} />Загрузить из WMS
        </button>
        <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => setReportModalOpen(true)}>
          <FileText size={14} strokeWidth={2} />Отчёт
        </button>
      </div>

      <div className={styles.subtabs}>
        {[
          { id: 'routes', label: 'По маршрутам' },
          { id: 'drivers', label: 'По водителям' },
          { id: 'cfz', label: 'По ЦФЗ' },
        ].map(tab => (
          <button
            key={tab.id}
            className={`${styles.subtab} ${activeView === tab.id ? styles.subtabActive : ''}`}
            onClick={() => switchView(tab.id)}
          >{tab.label}</button>
        ))}
      </div>

      {activeView === 'routes' && (
        <div className={styles.viewAnim}>
          <div className={styles.searchRow}>
            <input className={styles.searchInput} placeholder="Поиск по маршруту, водителю, адресу ЦФЗ..." value={routesSearch} onChange={e => setRoutesSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadRoutes(routesSearch)} />
          </div>
          <div className={styles.filterRow}>
            {[
              { id: 'all', label: 'Все' },
              { id: 'shipped', label: 'Отгружены' },
              { id: 'received', label: 'Приняты' },
              { id: 'unconfirmed', label: 'Не подтверждены' },
              { id: 'pending', label: 'Не обработаны' },
            ].map(f => (
              <button
                key={f.id}
                className={`${styles.filterChip} ${routesStatusFilter === f.id ? styles.filterChipActive : ''}`}
                onClick={() => setRoutesStatusFilter(f.id)}
              >{f.label}</button>
            ))}
            <div className={styles.dateFilter}>
              <input type="date" className={styles.dateInput} value={routesDateFrom} onChange={e => setRoutesDateFrom(e.target.value)} />
              <span className={styles.dateSep}>—</span>
              <input type="date" className={styles.dateInput} value={routesDateTo} onChange={e => setRoutesDateTo(e.target.value)} />
              {(routesDateFrom || routesDateTo) && (
                <button className={styles.dateClear} onClick={() => { setRoutesDateFrom(''); setRoutesDateTo('') }} title="Сбросить даты"><X size={13} strokeWidth={2} /></button>
              )}
            </div>
          </div>
          <RoutesView
            data={filteredRoutesData}
            loading={routesLoading}
            error={routesError}
            onOpenLightbox={openLightbox}
            onOpenEdit={setEditRouteId}
            onDataUpdate={handleRouteUpdate}
            onBulkDelete={handleBulkDelete}
          />
        </div>
      )}

      {activeView === 'drivers' && (
        <div className={styles.viewAnim}>
          <div className={styles.searchRow}>
            <input className={styles.searchInput} placeholder="Поиск по водителю..." value={driversSearch} onChange={e => setDriversSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadDrivers(driversSearch)} />
          </div>
          <DriversView data={driversData} loading={driversLoading} error={driversError} />
        </div>
      )}

      {activeView === 'cfz' && (
        <div className={styles.viewAnim}>
          <div className={styles.searchRow}>
            <input className={styles.searchInput} placeholder="Поиск по адресу ЦФЗ..." value={cfzSearch} onChange={e => setCfzSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadCfz(cfzSearch)} />
          </div>
          <CfzView data={cfzData} loading={cfzLoading} error={cfzError} />
        </div>
      )}

      <FetchModal open={fetchModalOpen} onOpenChange={setFetchModalOpen} onDone={() => loadRoutes(routesSearch)} />
      <ReportModal open={reportModalOpen} onOpenChange={setReportModalOpen} />

      {editRoute && (
        <ClassicEditModal
          route={editRoute}
          onClose={() => setEditRouteId(null)}
          onSaved={handleRouteUpdate}
        />
      )}

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
