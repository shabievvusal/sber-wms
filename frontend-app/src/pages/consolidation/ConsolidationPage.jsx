import { whKey } from '@/lib/warehouse'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { getStoredToken } from '@/lib/wmsFetch'
import { lookupViaBrowser } from './wmsLookup'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { DateRangePicker } from '@/components/ui/date-picker'
import { Table, TableHeader, TableBody, TableRow, TableHead } from '@/components/ui/table'
import { Spinner } from '@/components/ui/spinner'
import { Pagination } from '@/components/ui/pagination'
import { Select } from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import Lightbox from '@/components/shared/Lightbox'
import { confirmDialog } from '@/components/ui/confirm'
import { cn } from '@/lib/utils'
import { setHash } from '@/lib/hashRoute'
import { ComplaintRow, MobileComplaintCard, complaintStatus } from './ComplaintRow'
import { EditComplaintDialog } from './EditComplaintDialog'
import { ExportReportDialog } from './ExportReportDialog'
import { printServiceNotes } from './printServiceNote'
import { getSupervisors } from '@/pages/settings/supervisors'
import { Download, ExternalLink, Printer, RefreshCw, Search, ShieldAlert, Trash2, X } from 'lucide-react'

const PER_PAGE = 30
const LS_COMPANY_FULL_NAMES = 'sz_company_full_names'

function getCompanyFullNames() {
  try { return JSON.parse(localStorage.getItem(whKey(LS_COMPANY_FULL_NAMES)) || '{}') } catch { return {} }
}
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function Tile({ label, value, hint, tone, active, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className={cn('rounded-3xl border bg-card p-4 text-left shadow-card transition-colors hover:border-primary/50', active ? 'border-primary ring-2 ring-primary/20' : 'border-line')}>
      <div className="text-[13px] font-medium text-ink-2">{label}</div>
      <div className={cn('tabular mt-2 text-[26px] font-semibold leading-tight tracking-tight', tone)}>{value}</div>
      {hint && <div className="mt-1 text-sm text-muted-foreground">{hint}</div>}
    </button>
  )
}

// «Консолидация»: жалобы на нарушения при раскладке (подаются с телефона
// через форму для сотрудников) — поиск нарушителя в WMS, служебные записки
// и отчёты для подрядчиков.
export default function ConsolidationPage() {
  const [complaints, setComplaints] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  // по умолчанию — последние 30 дней (за период грузит сервер, а не всё сразу)
  const [range, setRange] = useState(() => ({ from: isoDay(new Date(Date.now() - 29 * 86400000)), to: '' }))
  const [status, setStatus] = useState('all')
  const [company, setCompany] = useState('')
  const [person, setPerson] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(() => new Set())
  const [page, setPage] = useState(1)

  const [lookupAllText, setLookupAllText] = useState(null)
  const [lookupBusyId, setLookupBusyId] = useState(null)
  const lookingUpRef = useRef(false)
  // адрес ячейки → id ячейки WMS (справочник «Ячейки и ЦФЗ» в настройках)
  const cellIdsRef = useRef(null)
  const cellIdOf = async address => {
    if (!cellIdsRef.current) {
      try {
        const r = await api.getCellStores()
        cellIdsRef.current = new Map((r?.cells || []).filter(c => c.cellId).map(c => [String(c.address).toUpperCase(), c.cellId]))
      } catch { cellIdsRef.current = new Map() }
    }
    return cellIdsRef.current.get(String(address || '').trim().toUpperCase()) || null
  }

  const [supervisor, setSupervisor] = useState(() => getSupervisors()[0] || '')
  const [photoModal, setPhotoModal] = useState(null) // { photos, idx } | null
  const [editComplaint, setEditComplaint] = useState(null)
  const [exportOpen, setExportOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const from = range.from ? new Date(`${range.from}T00:00:00`) : null
      const to = range.to ? new Date(`${range.to}T23:59:59.999`) : null
      const list = await api.getConsolidationComplaints({ from: from?.toISOString(), to: to?.toISOString() })
      setComplaints(list)
      setSelected(prev => new Set([...prev].filter(id => list.some(c => String(c.id) === id))))
    } catch (err) {
      setComplaints([])
      setLoadError(err.message || 'Не удалось загрузить жалобы')
    } finally {
      setLoading(false)
    }
  }, [range.from, range.to])
  useEffect(() => { load() }, [load])

  // ── Счётчики и фильтры ─────────────────────────────────────────────────
  const counts = useMemo(() => {
    const c = { all: complaints.length, new: 0, found: 0, not_found: 0, error: 0 }
    for (const x of complaints) c[complaintStatus(x).key]++
    return c
  }, [complaints])

  // problem — «не найден» и «ошибка поиска» вместе
  const byStatus = useMemo(() => (status === 'all' ? complaints : complaints.filter(c => {
    const k = complaintStatus(c).key
    return status === 'problem' ? k === 'not_found' || k === 'error' : k === status
  })), [complaints, status])
  const companyOptions = useMemo(() => [...new Set(byStatus.map(c => c.company).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')), [byStatus])
  const personOptions = useMemo(() => {
    const m = new Map()
    for (const c of byStatus) if (c.violator && (!company || c.company === company)) m.set(c.violator, (m.get(c.violator) || 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [byStatus, company])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return byStatus.filter(c => {
      if (company && c.company !== company) return false
      if (person && c.violator !== person) return false
      if (q && ![c.cell, c.barcode, c.nomenclatureCode, c.productName, c.violator, c.employeeName, c.handlingUnitBarcode].some(v => String(v || '').toLowerCase().includes(q))) return false
      return true
    })
  }, [byStatus, company, person, search])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  const safePage = Math.min(Math.max(1, page), totalPages)
  const pageItems = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE)
  const allPageChecked = pageItems.length > 0 && pageItems.every(c => selected.has(String(c.id)))
  const getSelected = () => complaints.filter(c => selected.has(String(c.id)))
  const topCompany = useMemo(() => {
    const m = new Map()
    for (const c of complaints) if (c.violator && c.company) m.set(c.company, (m.get(c.company) || 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0] || null
  }, [complaints])
  const resetPage = () => setPage(1)
  const hasFilters = status !== 'all' || company || person || search

  // ── Выбор ──────────────────────────────────────────────────────────────
  const toggleOne = id => setSelected(prev => {
    const next = new Set(prev)
    next.has(String(id)) ? next.delete(String(id)) : next.add(String(id))
    return next
  })
  const toggleAll = () => {
    const ids = pageItems.map(c => String(c.id))
    setSelected(prev => {
      const next = new Set(prev)
      ids.forEach(id => (allPageChecked ? next.delete(id) : next.add(id)))
      return next
    })
  }

  // ── Поиск нарушителя в WMS ─────────────────────────────────────────────
  const applyLookupResult = async (id, result) => {
    try { await api.saveComplaintLookup(id, result) } catch { /* отразим локально */ }
    setComplaints(prev => prev.map(c => (c.id === id ? { ...c, ...result } : c)))
  }
  const runLookup = async c => {
    const token = getStoredToken()
    if (!token) return { lookupDone: false, lookupError: 'Нет активного WMS-токена — войдите паролем от WMS' }
    try {
      return await lookupViaBrowser(token, c.barcode, c.cell, c.createdAt, c.handlingUnitBarcode, await cellIdOf(c.cell))
    } catch (err) {
      return { lookupDone: false, lookupError: err.message || 'Ошибка WMS' }
    }
  }
  const handleLookupOne = async c => {
    setLookupBusyId(c.id)
    const result = await runLookup(c)
    setLookupBusyId(null)
    if (result.violator) toast.success(`Нарушитель: ${result.violator}`)
    else if (result.lookupDone) toast.info('Нарушитель не найден')
    else toast.error(result.lookupError)
    return applyLookupResult(c.id, result)
  }
  const lookupMany = async list => {
    if (lookingUpRef.current || !list.length) return
    lookingUpRef.current = true
    let found = 0
    for (let i = 0; i < list.length; i++) {
      setLookupAllText(`${i + 1} из ${list.length}`)
      const r = await runLookup(list[i])
      if (r.violator) found++
      await applyLookupResult(list[i].id, r)
    }
    lookingUpRef.current = false
    setLookupAllText(null)
    toast.success(`Проверено: ${list.length}, нарушитель найден: ${found}`)
  }
  const handleLookupUnchecked = async () => {
    const todo = complaints.filter(c => !c.lookupDone || c.lookupError)
    if (todo.length) return lookupMany(todo)
    if (!(await confirmDialog({ title: 'Все жалобы уже проверены', description: 'Проверить все жалобы за период заново?', confirmText: 'Проверить заново' }))) return
    return lookupMany(complaints)
  }

  // ── Действия с выбранными ──────────────────────────────────────────────
  const handleBulkDelete = async () => {
    const sel = getSelected()
    if (!(await confirmDialog({ title: `Удалить жалобы (${sel.length})?`, description: 'Жалобы и их фото будут удалены без возможности восстановления.', confirmText: 'Удалить', danger: true }))) return
    const results = await Promise.allSettled(sel.map(c => api.deleteComplaint(c.id)))
    const fail = results.filter(r => r.status === 'rejected').length
    const ids = new Set(sel.map(c => c.id))
    setComplaints(prev => prev.filter(c => !ids.has(c.id)))
    setSelected(new Set())
    fail ? toast.error(`Удалено: ${results.length - fail}, с ошибкой: ${fail}`) : toast.success(`Удалено: ${sel.length}`)
  }
  const handlePrintSz = () => {
    if (!supervisor) { toast.error('Выберите начальника смены'); return }
    const ok = printServiceNotes(getSelected(), supervisor, getCompanyFullNames())
    if (!ok) toast.error('Разрешите всплывающие окна для печати')
  }

  const busy = !!lookupAllText

  return (
    <div className="mx-auto w-full space-y-4 p-6">
      {/* Шапка */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Консолидация</h1>
          <p className="text-sm text-muted-foreground">Жалобы на нарушения при раскладке: фото, поиск нарушителя в WMS, служебные записки и отчёты</p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setHash('consolidation-form')}><ExternalLink className="size-4" /> Форма для сотрудников</Button>
          <Button variant="secondary" onClick={() => setExportOpen(true)}><Download className="size-4" /> Отчёт для подрядчиков</Button>
        </div>
      </div>

      {loadError && <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">{loadError}</div>}

      {/* Итоги — они же быстрые фильтры */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Жалоб за период" value={counts.all.toLocaleString('ru-RU')} active={status === 'all'} onClick={() => { setStatus('all'); resetPage() }}
          hint={topCompany ? `чаще всего — ${topCompany[0]} (${topCompany[1]})` : ' '} />
        <Tile label="Нарушитель найден" value={counts.found.toLocaleString('ru-RU')} tone="text-success" active={status === 'found'} onClick={() => { setStatus('found'); resetPage() }}
          hint={counts.all ? `${Math.round((counts.found / counts.all) * 100)}% жалоб` : ' '} />
        <Tile label="Не проверены" value={counts.new.toLocaleString('ru-RU')} tone={counts.new ? 'text-info' : ''} active={status === 'new'} onClick={() => { setStatus('new'); resetPage() }}
          hint="ещё не искали в WMS" />
        <Tile label="Не найден / ошибка" value={(counts.not_found + counts.error).toLocaleString('ru-RU')} tone={counts.not_found + counts.error ? 'text-destructive' : ''} active={status === 'problem'} onClick={() => { setStatus('problem'); resetPage() }}
          hint={counts.error ? `из них ошибок поиска: ${counts.error}` : 'проверьте вручную'} />
      </div>

      {/* Фильтры и проверка */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-card p-3 shadow-card">
        <DateRangePicker className="h-9 w-60" from={range.from} to={range.to} onChange={r => { setRange(r); resetPage() }} placeholder="Весь период" />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-9 w-64 pl-8" value={search} onChange={e => { setSearch(e.target.value); resetPage() }} placeholder="Ячейка, штрихкод, товар, ФИО" />
        </div>
        <Select className="h-9 min-w-40" value={company} onChange={e => { setCompany(e.target.value); setPerson(''); resetPage() }}>
          <option value="">Все компании</option>
          {companyOptions.map(c => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Select className="h-9 min-w-48" value={person} onChange={e => { setPerson(e.target.value); resetPage() }}>
          <option value="">Все нарушители</option>
          {personOptions.map(([fio, n]) => <option key={fio} value={fio}>{fio} ({n})</option>)}
        </Select>
        {hasFilters && <Button size="sm" variant="ghost" onClick={() => { setStatus('all'); setCompany(''); setPerson(''); setSearch(''); resetPage() }}><X className="size-3.5" /> Сбросить</Button>}
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" size="icon" title="Обновить" onClick={load} disabled={loading}><RefreshCw className={cn('size-4', loading && 'animate-spin')} /></Button>
          <Button onClick={handleLookupUnchecked} disabled={busy || !complaints.length}>
            <ShieldAlert className="size-4" /> {busy ? `Поиск ${lookupAllText}…` : counts.new + counts.error ? `Найти нарушителей (${counts.new + counts.error})` : 'Найти нарушителей'}
          </Button>
        </div>
      </div>

      {/* Действия с выбранными */}
      {selected.size > 0 && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-2xl border border-primary/30 bg-card/95 p-2.5 shadow-card backdrop-blur">
          <span className="px-2 text-sm font-medium">Выбрано: {selected.size}</span>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => lookupMany(getSelected())}><Search className="size-3.5" /> Найти нарушителей</Button>
          <Popover>
            <PopoverTrigger asChild><Button size="sm" variant="secondary"><Printer className="size-3.5" /> Служебные записки</Button></PopoverTrigger>
            <PopoverContent align="start" className="w-72 space-y-2 p-3">
              <div className="text-sm font-medium">Начальник смены</div>
              <Select className="h-9 w-full" value={supervisor} onChange={e => setSupervisor(e.target.value)}>
                <option value="">— выберите —</option>
                {getSupervisors().map(n => <option key={n} value={n}>{n}</option>)}
              </Select>
              {!getSupervisors().length && <div className="text-xs text-muted-foreground">Список начальников смены — в Настройки → Документы</div>}
              <Button size="sm" className="w-full" onClick={handlePrintSz}><Printer className="size-3.5" /> Печать ({selected.size})</Button>
            </PopoverContent>
          </Popover>
          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={handleBulkDelete}><Trash2 className="size-3.5" /> Удалить</Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}><X className="size-3.5" /> Снять выбор</Button>
        </div>
      )}

      {photoModal && (
        <Lightbox photos={photoModal.photos} idx={photoModal.idx} onClose={() => setPhotoModal(null)}
          onNav={dir => setPhotoModal(p => ({ ...p, idx: (p.idx + dir + p.photos.length) % p.photos.length }))} />
      )}
      {editComplaint && (
        <EditComplaintDialog complaint={editComplaint} onOpenChange={open => !open && setEditComplaint(null)}
          onSaved={updated => { setComplaints(prev => prev.map(c => (c.id === updated.id ? updated : c))); setEditComplaint(null) }} />
      )}
      {exportOpen && <ExportReportDialog onOpenChange={setExportOpen} defaultFrom={range.from} defaultTo={range.to} />}

      {/* Список */}
      <div className="overflow-hidden rounded-2xl border border-line bg-card shadow-card">
        {loading && !complaints.length ? (
          <Spinner label="Загрузка жалоб…" />
        ) : !filtered.length ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            {complaints.length ? 'Под фильтры ничего не подходит' : 'За период жалоб нет. Сотрудники подают их с телефона через «Форму для сотрудников».'}
          </div>
        ) : (
          <>
            <div className="divide-y md:hidden">
              {pageItems.map(c => (
                <MobileComplaintCard key={c.id} complaint={c} selected={selected.has(String(c.id))} lookingUp={lookupBusyId === c.id}
                  onToggle={() => toggleOne(c.id)} onLookup={handleLookupOne} onEdit={setEditComplaint} onPhotoOpen={(photos, idx) => setPhotoModal({ photos, idx })} />
              ))}
            </div>
            <div className="hidden overflow-x-auto md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10"><Checkbox checked={allPageChecked} onCheckedChange={toggleAll} title="Выбрать все на странице" /></TableHead>
                    <TableHead className="w-16 text-[11px]">Фото</TableHead>
                    <TableHead className="text-[11px]">Подана</TableHead>
                    <TableHead className="text-[11px]">Ячейка</TableHead>
                    <TableHead className="text-[11px]">Товар</TableHead>
                    <TableHead className="text-[11px]">Нарушитель</TableHead>
                    <TableHead className="text-[11px]">Статус</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageItems.map(c => (
                    <ComplaintRow key={c.id} complaint={c} selected={selected.has(String(c.id))} lookingUp={lookupBusyId === c.id}
                      onToggle={() => toggleOne(c.id)} onLookup={handleLookupOne} onEdit={setEditComplaint} onPhotoOpen={(photos, idx) => setPhotoModal({ photos, idx })} />
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-xs text-muted-foreground">
              <span>{(safePage - 1) * PER_PAGE + 1}–{Math.min(safePage * PER_PAGE, filtered.length)} из {filtered.length}</span>
              {totalPages > 1 && <Pagination page={safePage} totalPages={totalPages} onChange={setPage} />}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
