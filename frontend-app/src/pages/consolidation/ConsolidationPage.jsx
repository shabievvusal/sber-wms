import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { getStoredToken } from '@/lib/wmsFetch'
import { lookupViaBrowser } from './wmsLookup'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DateRangePicker } from '@/components/ui/date-picker'
import { Table, TableHeader, TableBody, TableRow, TableHead } from '@/components/ui/table'
import { Spinner } from '@/components/ui/spinner'
import { Pagination } from '@/components/ui/pagination'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import Lightbox from '@/components/shared/Lightbox'
import { ComplaintRow, MobileComplaintCard } from './ComplaintRow'
import { EditComplaintDialog } from './EditComplaintDialog'
import { ExportReportDialog } from './ExportReportDialog'
import { printServiceNotes } from './printServiceNote'
import { setHash } from '@/lib/hashRoute'
import { RefreshCw, Search, Printer, Download, ExternalLink } from 'lucide-react'

const COMPLAINTS_PER_PAGE = 30
const LS_COMPANY_FULL_NAMES = 'sz_company_full_names'
const LS_SUPERVISORS = 'memos_supervisors'

function getCompanyFullNames() {
  try { return JSON.parse(localStorage.getItem(LS_COMPANY_FULL_NAMES) || '{}') } catch { return {} }
}
function getSupervisorOptions() {
  try { return JSON.parse(localStorage.getItem(LS_SUPERVISORS) || '[]') } catch { return [] }
}

const selectClass = 'h-8 rounded-md border border-input bg-transparent px-2 text-sm'

export default function ConsolidationPage() {
  const [complaints, setComplaints] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [violatorFilter, setViolatorFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [companyFilter, setCompanyFilter] = useState('')
  const [violatorPersonFilter, setViolatorPersonFilter] = useState('')

  const [selected, setSelected] = useState(() => new Set())
  const [page, setPage] = useState(1)

  const [lookupAllText, setLookupAllText] = useState(null)
  const [lookupBusyId, setLookupBusyId] = useState(null)
  const lookingUpRef = useRef(false)

  const [supervisor, setSupervisor] = useState(() => getSupervisorOptions()[0] || '')
  const [photoModal, setPhotoModal] = useState(null) // { photos, idx } | null
  const [editComplaint, setEditComplaint] = useState(null)
  const [exportOpen, setExportOpen] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setLoadError('')
    return withMinDuration(async () => {
      try {
        const list = await api.getConsolidationComplaints()
        setComplaints(list)
        setSelected(prev => new Set([...prev].filter(id => list.some(c => String(c.id) === id))))
      } catch (err) {
        setComplaints([])
        setLoadError(err.message || 'Не удалось загрузить жалобы')
      }
    }).finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  // ── Derived ────────────────────────────────────────────────────────────
  const preFiltered = complaints.filter(c => {
    if (violatorFilter === 'found' && !c.violator) return false
    if (violatorFilter === 'not_found' && c.violator) return false
    if (dateFrom && c.createdAt < new Date(dateFrom).toISOString()) return false
    if (dateTo) {
      const toDate = new Date(dateTo)
      toDate.setHours(23, 59, 59, 999)
      if (c.createdAt > toDate.toISOString()) return false
    }
    return true
  })

  const companyOptions = [...new Set(preFiltered.map(c => c.company || '').filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ru'))

  const violatorOptions = (() => {
    const vm = new Map()
    for (const c of preFiltered) {
      if (companyFilter && c.company !== companyFilter) continue
      if (!c.violator) continue
      vm.set(c.violator, (vm.get(c.violator) || 0) + 1)
    }
    return [...vm.entries()].sort((a, b) => b[1] - a[1]).map(([fio, count]) => ({ fio, count }))
  })()

  const filtered = preFiltered.filter(c => {
    if (companyFilter && c.company !== companyFilter) return false
    if (violatorPersonFilter && c.violator !== violatorPersonFilter) return false
    return true
  })

  const totalPages = Math.max(1, Math.ceil(filtered.length / COMPLAINTS_PER_PAGE))
  const safePage = Math.min(Math.max(1, page), totalPages)
  const pageItems = filtered.slice((safePage - 1) * COMPLAINTS_PER_PAGE, safePage * COMPLAINTS_PER_PAGE)
  const countFound = complaints.filter(c => c.violator).length
  const countNotFound = complaints.filter(c => !c.violator).length
  const allPageChecked = pageItems.length > 0 && pageItems.every(c => selected.has(String(c.id)))
  const getSelected = () => complaints.filter(c => selected.has(String(c.id)))

  // ── Handlers ───────────────────────────────────────────────────────────
  const toggleOne = id => setSelected(prev => {
    const next = new Set(prev)
    next.has(String(id)) ? next.delete(String(id)) : next.add(String(id))
    return next
  })
  const toggleAll = () => {
    const ids = pageItems.map(c => String(c.id))
    setSelected(prev => {
      const next = new Set(prev)
      ids.forEach(id => allPageChecked ? next.delete(id) : next.add(id))
      return next
    })
  }

  const applyLookupResult = async (id, result) => {
    try { await api.saveComplaintLookup(id, result) } catch { /* ignore, still reflect locally */ }
    setComplaints(prev => prev.map(c => c.id === id ? { ...c, ...result } : c))
  }

  // Реальный поиск через WMS-токен (см. AuthContext.jsx). Без токена — честная
  // ошибка (как в оригинале, там `alert('Войдите в WMS для поиска')`), а не
  // фальшивый результат.
  const runLookup = async c => {
    const token = getStoredToken()
    if (!token) return { lookupDone: false, lookupError: 'Нет активного WMS-токена — войдите паролем от WMS' }
    try {
      return await lookupViaBrowser(token, c.barcode, c.cell, c.createdAt, c.handlingUnitBarcode)
    } catch (err) {
      return { lookupDone: false, lookupError: err.message || 'Ошибка WMS' }
    }
  }

  const handleLookupOne = async c => {
    setLookupBusyId(c.id)
    const result = await withMinDuration(async () => runLookup(c))
    setLookupBusyId(null)
    if (result.lookupDone) toast.success('Поиск завершён')
    else toast.error(result.lookupError)
    return applyLookupResult(c.id, result)
  }

  const handleLookupAll = async () => {
    if (lookingUpRef.current) return
    let needLookup = complaints.filter(c => !c.lookupDone)
    if (needLookup.length === 0) {
      if (!confirm('Все жалобы уже проверены. Проверить заново?')) return
      needLookup = [...complaints]
    }
    lookingUpRef.current = true
    for (let i = 0; i < needLookup.length; i++) {
      setLookupAllText(`${i + 1}/${needLookup.length}...`)
      await applyLookupResult(needLookup[i].id, await runLookup(needLookup[i]))
    }
    lookingUpRef.current = false
    setLookupAllText(null)
    toast.success(`Проверено жалоб: ${needLookup.length}`)
  }

  const handleBulkLookup = async () => {
    const sel = getSelected()
    if (!sel.length) { toast.error('Отметьте жалобы галочкой'); return }
    for (const c of sel) await applyLookupResult(c.id, await runLookup(c))
    toast.success(`Проверено: ${sel.length}`)
  }

  const handleBulkDelete = async () => {
    const sel = getSelected()
    if (!sel.length) { toast.error('Отметьте жалобы галочкой'); return }
    if (!confirm(`Удалить выбранные жалобы (${sel.length})?`)) return
    const results = await Promise.allSettled(sel.map(c => api.deleteComplaint(c.id)))
    const fail = results.filter(r => r.status === 'rejected').length
    if (fail > 0) toast.error(`Удалено: ${results.length - fail}, с ошибкой: ${fail}`)
    const ids = new Set(sel.map(c => c.id))
    setComplaints(prev => prev.filter(c => !ids.has(c.id)))
    setSelected(new Set())
    toast.success(`Удалено: ${sel.length}`)
  }

  const handlePrintSz = () => {
    const sel = getSelected()
    if (!sel.length) { toast.error('Отметьте галочками жалобы для печати СЗ'); return }
    const ok = printServiceNotes(sel, supervisor, getCompanyFullNames())
    if (!ok) toast.error('Разрешите всплывающие окна для печати')
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Жалобы на нарушения</h1>
        <p className="text-sm text-muted-foreground">Раздел исторически называется «Консолидация» — см. PLAN.md</p>
      </div>

      {loadError && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          {loadError}
        </div>
      )}

      {photoModal && (
        <Lightbox
          photos={photoModal.photos}
          idx={photoModal.idx}
          onClose={() => setPhotoModal(null)}
          onNav={dir => setPhotoModal(p => ({ ...p, idx: (p.idx + dir + p.photos.length) % p.photos.length }))}
        />
      )}
      {editComplaint && (
        <EditComplaintDialog
          complaint={editComplaint}
          onOpenChange={open => !open && setEditComplaint(null)}
          onSaved={updated => { setComplaints(prev => prev.map(c => c.id === updated.id ? updated : c)); setEditComplaint(null) }}
        />
      )}
      {exportOpen && <ExportReportDialog onOpenChange={setExportOpen} />}

      {/* Toolbar */}
      <div className="space-y-3 rounded-lg border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={load}><RefreshCw className="size-3.5" /> Обновить</Button>
          <Button size="sm" variant="secondary" disabled={!!lookupAllText} onClick={handleLookupAll}>
            <Search className="size-3.5" /> {lookupAllText ? `Проверка ${lookupAllText}` : 'Проверить все'}
          </Button>
          <Button size="sm" variant="secondary" onClick={handlePrintSz}><Printer className="size-3.5" /> Создать СЗ</Button>
          <Button size="sm" variant="secondary" onClick={() => setExportOpen(true)}><Download className="size-3.5" /> Выгрузить отчёт</Button>
          <Button size="sm" variant="secondary" onClick={() => setHash('consolidation-form')} title="Кио­ск-форма для сотрудников склада">
            <ExternalLink className="size-3.5" /> Форма для сотрудников
          </Button>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground whitespace-nowrap">Начальник смены:</span>
            <select className={selectClass} value={supervisor} onChange={e => setSupervisor(e.target.value)}>
              <option value="">— Выберите —</option>
              {getSupervisorOptions().map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button size="sm" variant="secondary" onClick={handleBulkLookup}>Проверить выбранные</Button>
          <Button size="sm" variant="destructive" onClick={handleBulkDelete}>Удалить выбранные</Button>
          <div className="h-4 w-px bg-border" />
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>Всего: <b className="text-foreground">{complaints.length}</b></span>
            <span>Найдено: <b className="text-foreground">{countFound}</b></span>
            <span>Не найдено: <b className="text-foreground">{countNotFound}</b></span>
            <span>Выбрано: <b className="text-foreground">{selected.size}</b></span>
          </div>
          <div className="ml-auto flex items-center gap-1.5 rounded-md border bg-muted/30 p-1">
            {[{ val: 'all', label: 'Все' }, { val: 'found', label: 'Нарушитель найден' }, { val: 'not_found', label: 'Не найден' }].map(({ val, label }) => (
              <Button key={val} size="sm" variant={violatorFilter === val ? 'default' : 'ghost'} onClick={() => { setViolatorFilter(val); setPage(1) }}>
                {label}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <span className="text-xs text-muted-foreground whitespace-nowrap">Дата подачи:</span>
          <DateRangePicker from={dateFrom} to={dateTo} onChange={r => { setDateFrom(r.from); setDateTo(r.to); setPage(1) }} className="w-64" />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <span className="text-xs text-muted-foreground whitespace-nowrap">Компания:</span>
          <select className={selectClass} value={companyFilter} onChange={e => { setCompanyFilter(e.target.value); setViolatorPersonFilter(''); setPage(1) }}>
            <option value="">Все</option>
            {companyOptions.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          {companyFilter && (
            <>
              <span className="text-xs text-muted-foreground whitespace-nowrap">Нарушитель:</span>
              <select className={selectClass} value={violatorPersonFilter} onChange={e => { setViolatorPersonFilter(e.target.value); setPage(1) }}>
                <option value="">Все</option>
                {violatorOptions.map(({ fio, count }) => <option key={fio} value={fio}>{fio} ({count})</option>)}
              </select>
            </>
          )}
          {(companyFilter || violatorPersonFilter) && (
            <Button size="sm" variant="ghost" onClick={() => { setCompanyFilter(''); setViolatorPersonFilter(''); setPage(1) }}>✕</Button>
          )}
        </div>
      </div>

      <Card className="overflow-visible">
        <CardHeader className="flex-row items-center justify-between gap-2 border-b p-4">
          <CardTitle>Жалобы на нарушения</CardTitle>
        </CardHeader>

        {filtered.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5 text-xs text-muted-foreground">
            <span>
              Стр. {safePage}/{totalPages} • {(safePage - 1) * COMPLAINTS_PER_PAGE + 1}–{Math.min(safePage * COMPLAINTS_PER_PAGE, filtered.length)} из {filtered.length}
            </span>
            <Pagination page={safePage} totalPages={totalPages} onChange={setPage} />
          </div>
        )}

        <div>
          {loading ? (
            <Spinner label="Загрузка жалоб..." />
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Нет жалоб</div>
          ) : (
            <>
              {/* Мобильные карточки — до md (768px) */}
              <div className="divide-y md:hidden">
                {pageItems.map(c => (
                  <MobileComplaintCard
                    key={c.id}
                    complaint={c}
                    selected={selected.has(String(c.id))}
                    lookingUp={lookupBusyId === c.id}
                    onToggle={() => toggleOne(c.id)}
                    onLookup={handleLookupOne}
                    onEdit={setEditComplaint}
                    onPhotoOpen={(photos, idx) => setPhotoModal({ photos, idx })}
                  />
                ))}
              </div>

              {/* Десктопная таблица — от md и шире */}
              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead><Checkbox checked={allPageChecked} onCheckedChange={toggleAll} title="Выбрать все на странице" /></TableHead>
                      <TableHead>Дата</TableHead>
                      <TableHead>Кто подал</TableHead>
                      <TableHead>Место</TableHead>
                      <TableHead>Штрихкод</TableHead>
                      <TableHead>Артикул</TableHead>
                      <TableHead>Товар</TableHead>
                      <TableHead>Нарушитель</TableHead>
                      <TableHead>Компания</TableHead>
                      <TableHead>Время нарушения</TableHead>
                      <TableHead>Действия</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageItems.map(c => (
                      <ComplaintRow
                        key={c.id}
                        complaint={c}
                        selected={selected.has(String(c.id))}
                        lookingUp={lookupBusyId === c.id}
                        onToggle={() => toggleOne(c.id)}
                        onLookup={handleLookupOne}
                        onEdit={setEditComplaint}
                        onPhotoOpen={(photos, idx) => setPhotoModal({ photos, idx })}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>
      </Card>
    </div>
  )
}
