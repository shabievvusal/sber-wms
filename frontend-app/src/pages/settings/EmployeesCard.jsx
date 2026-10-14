import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EditableCell } from '@/components/ui/editable-cell'
import { Spinner } from '@/components/ui/spinner'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { SettingCard } from './SettingCard'
import { QuickAssignDialog } from './QuickAssignDialog'
import { exportEmployeesXlsx } from './employeesExport'
import { ListPager, clampPage } from './ui'
import {
  Users, Download, X, Search, MoreHorizontal, ScanSearch, Trash2, Undo2, Save, UserPlus, Pencil,
} from 'lucide-react'

// Список сотрудников (Настройки → Сотрудники).
//
// Почему так устроено:
//  • Фильтр «замораживается»: какие строки видны, считается только при смене
//    поиска/компании или состава списка (загрузка, удаление, назначение
//    компании), а НЕ при правке полей. Раньше фильтр пересчитывался на каждую
//    букву по редактируемым полям, и сотрудник исчезал из выдачи прямо во
//    время правки.
//  • Строки дешёвые: ячейка — это текст, поле ввода появляется только в той
//    ячейке, которую сейчас правят; строки мемоизированы, правка одной не
//    перерисовывает остальные; список разбит на страницы, и рисуется только
//    одна раскладка (таблица или карточки). Раньше на
//    каждого сотрудника было 8 полей ввода (таблица + скрытые карточки), и
//    каждая буква перерисовывала весь список — подвисала вся страница.
//  • Добавить сотрудника вручную, загрузить список из CSV и «привязать UUID»
//    нельзя (решение пользователя): без ID исполнителя из WMS человеку в
//    списке делать нечего, а сервер такие строки всё равно не сохраняет.
//    Сотрудники попадают сюда сами из статистики WMS («Найти новых в сменах»).

const PAGE_SIZE = 50
const ALL = '__all__'
const NONE = '__none__'

// «ИВАНОВ иван» → «Иванов Иван». Заглавной делается первая БУКВА слова, а не
// первый символ: из WMS бывают ФИО с мусором в начале («=Ракеш», «-Иван»).
function titleCaseFio(str) {
  return (str || '').replace(/\S+/g, w => w.toLowerCase().replace(/[a-zа-яё]/i, c => c.toUpperCase()))
}

const snapshotKey = r => `${r.fio}\u0001${r.company}\u0001${r.phone || ''}\u0001${r.password || ''}`
const initials = fio => (fio || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase()

// Цвет компании — стабильный по названию, из палитры графиков WMS
const COMPANY_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#7c3aed', '#0ea5e9', '#d97706']
function companyColor(name) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return COMPANY_COLORS[h % COMPANY_COLORS.length]
}

function useIsDesktop() {
  const query = '(min-width: 768px)'
  const [ok, setOk] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setOk(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return ok
}

function CompanyBadge({ company }) {
  if (!company) return <span className="text-xs text-muted-foreground">без компании</span>
  const c = companyColor(company)
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 truncate rounded-full px-2.5 py-0.5 text-xs font-medium"
      style={{ background: `color-mix(in oklab, ${c} 13%, transparent)`, color: c }}
      title={company}
    >
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: c }} />
      <span className="truncate">{company}</span>
    </span>
  )
}

const DesktopRow = memo(function DesktopRow({ row, state, onChange, onDelete }) {
  return (
    <tr className={cn('group border-b border-line last:border-0 transition-colors hover:bg-surface-2/40', state === 'dirty' && 'bg-warning/5')}>
      <td className="py-1.5 pr-1 pl-3">
        <div className="flex items-center gap-2.5">
          <span className="relative grid size-8 shrink-0 place-items-center rounded-xl bg-brand-soft text-xs font-semibold text-brand">
            {initials(row.fio)}
            {state === 'dirty' && <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-warning ring-2 ring-card" title="Изменён" />}
          </span>
          <EditableCell value={row.fio} placeholder="ФИО" className="flex-1 font-medium" onCommit={v => onChange(row._id, 'fio', v)} />
        </div>
      </td>
      <td className="px-1 py-1.5">
        <EditableCell value={row.company} placeholder="Компания" list="empl-companies-dl" display={v => <CompanyBadge company={v} />} onCommit={v => onChange(row._id, 'company', v)} />
      </td>
      <td className="px-1 py-1.5">
        <EditableCell value={row.phone || ''} placeholder="Телефон" className="tabular" onCommit={v => onChange(row._id, 'phone', v)} />
      </td>
      <td className="px-1 py-1.5">
        <EditableCell value={row.password || ''} placeholder="Пароль" className="font-mono text-[13px]" onCommit={v => onChange(row._id, 'password', v)} />
      </td>
      <td className="py-1.5 pr-3 pl-1 text-right">
        <button
          type="button"
          onClick={() => onDelete(row._id)}
          title="Удалить из списка"
          className="grid size-8 place-items-center rounded-lg text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Trash2 className="size-4" />
        </button>
      </td>
    </tr>
  )
})

const MobileRow = memo(function MobileRow({ row, state, onOpen }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(row._id)}
      className={cn('flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-left last:border-0 active:bg-surface-2', state === 'dirty' && 'bg-warning/5')}
    >
      <span className="relative grid size-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-sm font-semibold text-brand">
        {initials(row.fio)}
        {state === 'dirty' && <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-warning ring-2 ring-card" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{row.fio || <span className="text-muted-foreground">Без ФИО</span>}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-2">
          <CompanyBadge company={row.company} />
          {row.phone && <span className="tabular truncate text-xs text-muted-foreground">{row.phone}</span>}
        </span>
      </span>
      <Pencil className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
})

function MobileEditDialog({ row, onChange, onDelete, onClose }) {
  const [form, setForm] = useState(row)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const save = () => {
    for (const k of ['fio', 'company', 'phone', 'password']) if ((form[k] || '') !== (row[k] || '')) onChange(row._id, k, form[k])
    onClose()
  }
  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Сотрудник</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {[['fio', 'ФИО'], ['company', 'Компания'], ['phone', 'Телефон'], ['password', 'Пароль']].map(([k, label]) => (
            <label key={k} className="block space-y-1 text-sm">
              <span className="text-muted-foreground">{label}</span>
              <Input value={form[k] || ''} list={k === 'company' ? 'empl-companies-dl' : undefined} onChange={e => set(k, e.target.value)} placeholder={label} />
            </label>
          ))}
        </div>
        <DialogFooter className="flex-row justify-between gap-2 sm:justify-between">
          <Button variant="ghost" className="text-destructive" onClick={() => { onDelete(row._id); onClose() }}><Trash2 className="size-4" /> Удалить</Button>
          <Button onClick={save}>Готово</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MenuItem({ icon: Icon, children, onClick, disabled }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-50">
      <Icon className="size-4 text-muted-foreground" />{children}
    </button>
  )
}

export function EmployeesCard() {
  const isDesktop = useIsDesktop()
  const [rows, setRows] = useState([])
  const [allCompanies, setAllCompanies] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [search, setSearch] = useState('')
  const [companyFilter, setCompanyFilter] = useState(ALL)
  const [quickAssign, setQuickAssign] = useState(null)
  const [localSaved, setLocalSaved] = useState(() => new Set())
  const [scanResult, setScanResult] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [showAllUnassigned, setShowAllUnassigned] = useState(false)
  const [addingFound, setAddingFound] = useState(false)
  const [editingMobile, setEditingMobile] = useState(null)
  const [page, setPage] = useState(1)
  // Состав списка (не содержимое полей): по нему пересчитывается фильтр
  const [structVersion, setStructVersion] = useState(0)
  const bump = () => setStructVersion(v => v + 1)

  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const origRef = useRef({ rows: [], keys: new Map() })
  const listTopRef = useRef(null)

  const setOriginal = list => {
    origRef.current = { rows: list, keys: new Map(list.map(r => [r._id, snapshotKey(r)])) }
  }

  const load = () => {
    setLoading(true)
    return withMinDuration(async () => {
      try {
        const res = await api.getEmployees()
        const list = (res.employees || []).filter(e => e.executorId).map(e => ({ fio: titleCaseFio(e.fio), company: e.company || '', phone: e.phone || '', password: e.password || '', executorId: e.executorId, _id: e.executorId }))
        setAllCompanies(res.companies || [])
        setRows(list)
        setOriginal(list)
        setLoadError('')
      } catch (err) {
        setAllCompanies([])
        setRows([])
        setOriginal([])
        setLoadError(err.message || 'Не удалось загрузить сотрудников')
      }
      bump()
    }).finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    // «Без компании» — сразу сканируем все смены, не ждём ручного клика
    handleScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── Изменения относительно загруженного ────────────────────────────────
  const rowState = useMemo(() => {
    const keys = origRef.current.keys
    const m = new Map()
    for (const r of rows) m.set(r._id, keys.get(r._id) !== snapshotKey(r) ? 'dirty' : 'clean')
    return m
  }, [rows])
  const changes = useMemo(() => {
    let edited = 0
    for (const r of rows) if (rowState.get(r._id) === 'dirty') edited++
    const removed = Math.max(0, origRef.current.rows.length - rows.length)
    return { edited, removed, total: edited + removed }
  }, [rows, rowState])

  // ─── Фильтр (замороженный, см. комментарий в начале файла) ──────────────
  // фильтрация по отложенному значению — поле поиска откликается сразу, список догоняет
  const q = useDeferredValue(search).trim().toLowerCase()
  const visibleIds = useMemo(() => {
    const out = []
    for (const r of rowsRef.current) {
      if (companyFilter === NONE && r.company) continue
      if (companyFilter !== ALL && companyFilter !== NONE && r.company !== companyFilter) continue
      if (q && !(r.fio.toLowerCase().includes(q) || r.company.toLowerCase().includes(q) || String(r.phone || '').toLowerCase().includes(q))) continue
      out.push(r._id)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, companyFilter, structVersion])

  const companyCounts = useMemo(() => {
    const m = new Map()
    let none = 0
    for (const r of rowsRef.current) {
      if (!r.company) none++
      else m.set(r.company, (m.get(r.company) || 0) + 1)
    }
    return { m, none }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structVersion])

  const rowsById = useMemo(() => new Map(rows.map(r => [r._id, r])), [rows])
  const visibleRows = useMemo(() => visibleIds.map(id => rowsById.get(id)).filter(Boolean), [visibleIds, rowsById])
  // страница не «вываливается» за конец, если список стал короче (удаление)
  const curPage = clampPage(page, visibleRows.length, PAGE_SIZE)
  const shownRows = visibleRows.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE)

  useEffect(() => { setPage(1) }, [q, companyFilter])

  const goToPage = p => {
    setPage(p)
    // к началу списка — иначе после перехода видна середина новой страницы
    const el = listTopRef.current
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  const noCompanyEmployees = useMemo(() => {
    if (!scanResult) return []
    return scanResult.filter(e => !localSaved.has(`id:${e.executorId}`))
  }, [scanResult, localSaved])

  // ─── Действия ───────────────────────────────────────────────────────────
  const handleRowChange = useCallback((_id, field, value) => {
    setRows(prev => prev.map(r => (r._id === _id ? { ...r, [field]: value } : r)))
  }, [])

  const handleDeleteRow = useCallback(_id => {
    setRows(prev => prev.filter(r => r._id !== _id))
    bump()
  }, [])

  const handleOpenMobile = useCallback(_id => setEditingMobile(_id), [])

  const handleDiscard = () => {
    setRows(origRef.current.rows)
    bump()
    toast.info('Изменения отменены')
  }

  const doSaveEmpl = async (fio, company, executorId = null) => {
    try {
      const data = await api.saveEmplOne(fio, company, executorId)
      if (!data.ok) { toast.error('Ошибка: ' + (data.error || 'не удалось сохранить')); return }
      toast.success('Сохранено')
      if (executorId) setLocalSaved(prev => new Set([...prev, `id:${executorId}`]))
      const apply = list => {
        const exists = list.some(r => r.executorId === executorId)
        return exists
          ? list.map(r => (r.executorId === executorId ? { ...r, fio, company } : r))
          : [{ fio, company, phone: '', password: '', executorId, _id: executorId }, ...list]
      }
      // запись уже на сервере — она же и «исходная», чтобы не считаться несохранённой
      setOriginal(apply(origRef.current.rows))
      setRows(apply)
      bump()
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    }
  }

  // Найденные в сменах (их нет в списке) — сразу в список без компании, чтобы
  // уведомление не висело постоянно; компанию можно назначить позже прямо в
  // таблице (фильтр «Без компании»). Пишется сразу на сервер (/api/empl/add-new),
  // как и назначение компании по одному.
  const handleAddAllFound = async () => {
    const list = noCompanyEmployees
    if (!list.length) return
    setAddingFound(true)
    try {
      const res = await api.addNewEmployees(list.map(e => ({ executorId: e.executorId, fio: titleCaseFio(e.fio) })))
      if (res && res.ok === false) { toast.error('Ошибка: ' + (res.error || 'не удалось добавить')); return }
      const newRows = list.map(e => ({ fio: titleCaseFio(e.fio), company: '', phone: '', password: '', executorId: e.executorId, _id: e.executorId }))
      const apply = cur => {
        const ids = new Set(cur.map(r => r._id))
        return [...newRows.filter(r => !ids.has(r._id)), ...cur]
      }
      setOriginal(apply(origRef.current.rows))
      setRows(apply)
      bump()
      setLocalSaved(prev => new Set([...prev, ...list.map(e => `id:${e.executorId}`)]))
      toast.success(`Добавлено в список: ${res?.added ?? list.length} · компанию можно назначить в фильтре «Без компании»`)
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setAddingFound(false)
    }
  }

  const handleExportXlsx = async () => {
    setMenuOpen(false)
    if (!rows.length) { toast.error('Нет данных для выгрузки'); return }
    try {
      await exportEmployeesXlsx(rows)
    } catch (err) {
      toast.error('Не удалось сформировать файл: ' + err.message)
    }
  }


  const handleSave = async () => {
    // Сервер сохраняет список ЦЕЛИКОМ (очищает таблицу и пишет заново).
    const all = rows.filter(r => r.fio.trim() && r.executorId).map(r => ({ fio: r.fio, company: r.company, phone: r.phone || '', password: r.password || '', executorId: r.executorId }))
    const before = origRef.current.rows.filter(r => r.executorId).length
    if (before > 0 && all.length === 0) {
      toast.error('Сохранение остановлено: в списке не осталось сотрудников — сохранение стёрло бы весь список на сервере')
      return
    }
    if (before > 20 && all.length < before / 2 &&
      !window.confirm(`Будет сохранено ${all.length} из ${before} сотрудников — остальные удалятся с сервера. Продолжить?`)) return
    setSaving(true)
    try {
      const res = await api.saveEmployeesAll(all)
      if (!res.ok) { toast.error('Ошибка: ' + res.error); return }
      toast.success(`Сохранено ${all.length} сотрудников`)
      // на сервере теперь ровно то, что отправили
      const saved = rows.filter(r => r.executorId && r.fio.trim())
      setOriginal(saved)
      setRows(saved)
      bump()
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleScan = async () => {
    setMenuOpen(false)
    setScanning(true); setScanResult(null)
    try {
      await withMinDuration(async () => {
        try {
          const data = await api.findUnregisteredEmployees()
          setScanResult(data.employees || [])
        } catch (err) {
          setScanResult([])
          toast.error(err.message || 'Не удалось выполнить поиск')
        }
      })
    } finally {
      setScanning(false)
    }
  }

  const companies = useMemo(() => {
    const set = new Set(allCompanies)
    for (const c of companyCounts.m.keys()) set.add(c)
    return [...set].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }))
  }, [allCompanies, companyCounts])

  const subtitle = loadError
    || (loading ? 'Загрузка...' : rows.length ? `${rows.length} сотрудников · ${companies.length} компаний` : 'Список пуст — сотрудники появятся из статистики WMS')

  const chips = [
    { value: ALL, label: 'Все', count: rowsRef.current.length },
    ...companies.map(c => ({ value: c, label: c, count: companyCounts.m.get(c) || 0, color: companyColor(c) })),
    { value: NONE, label: 'Без компании', count: companyCounts.none },
  ]

  const unassignedShown = showAllUnassigned ? noCompanyEmployees : noCompanyEmployees.slice(0, 24)
  const editingRow = editingMobile ? rowsById.get(editingMobile) : null

  return (
    <SettingCard icon={Users} title="Список сотрудников" subtitle={subtitle}>
      {quickAssign && (
        <QuickAssignDialog
          fio={quickAssign.fio}
          companies={companies}
          onOpenChange={open => !open && setQuickAssign(null)}
          onSave={async company => { const { fio, executorId } = quickAssign; setQuickAssign(null); await doSaveEmpl(fio, company, executorId) }}
        />
      )}
      {editingRow && (
        <MobileEditDialog key={editingRow._id} row={editingRow} onChange={handleRowChange} onDelete={handleDeleteRow} onClose={() => setEditingMobile(null)} />
      )}
      <datalist id="empl-companies-dl">
        {companies.map(c => <option key={c} value={c} />)}
      </datalist>

      {/* Найдены в сменах, но их нет в списке */}
      {noCompanyEmployees.length > 0 && (
        <div className="mb-4 rounded-2xl border border-warning/30 bg-warning/[0.06] p-3.5">
          <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-warning/15 text-warning"><UserPlus className="size-4" /></span>
            <div className="min-w-0 flex-1 basis-64">
              <div className="text-sm font-semibold">Новые из смен: {noCompanyEmployees.length}</div>
              <div className="text-xs text-muted-foreground">Работали в сменах, но их нет в списке. Нажмите на человека, чтобы сразу указать компанию, или добавьте всех без компании.</div>
            </div>
            <Button size="sm" variant="outline" onClick={handleAddAllFound} disabled={addingFound}>
              <UserPlus className="size-3.5" /> {addingFound ? 'Добавляю…' : `Добавить всех без компании (${noCompanyEmployees.length})`}
            </Button>
            <button type="button" className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-surface-2 hover:text-foreground" title="Скрыть до следующего открытия" onClick={() => setScanResult(null)}>
              <X className="size-4" />
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {unassignedShown.map(e => (
              <button
                key={e.executorId}
                type="button"
                className="rounded-full border border-line bg-card px-3 py-1 text-xs font-medium shadow-card transition-colors hover:border-brand hover:text-brand"
                onClick={() => setQuickAssign({ fio: titleCaseFio(e.fio), executorId: e.executorId })}
              >
                {titleCaseFio(e.fio)}
              </button>
            ))}
            {noCompanyEmployees.length > unassignedShown.length && (
              <button type="button" className="rounded-full px-3 py-1 text-xs font-medium text-brand hover:underline" onClick={() => setShowAllUnassigned(true)}>
                ещё {noCompanyEmployees.length - unassignedShown.length}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Панель: поиск и прочие действия */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full min-w-0 sm:w-auto sm:max-w-sm sm:flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pr-8 pl-9" placeholder="Поиск по ФИО, компании, телефону" value={search} onChange={e => setSearch(e.target.value)} />
          {search && (
            <button type="button" className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:text-foreground" onClick={() => setSearch('')} title="Очистить">
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="icon" title="Ещё действия"><MoreHorizontal className="size-4" /></Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 p-1.5">
            <MenuItem icon={ScanSearch} onClick={handleScan} disabled={scanning}>{scanning ? 'Ищу в сменах…' : 'Найти новых в сменах'}</MenuItem>
            <MenuItem icon={Download} onClick={handleExportXlsx}>Выгрузить в Excel</MenuItem>
          </PopoverContent>
        </Popover>
        {scanResult !== null && scanResult.length === 0 && (
          <span className="text-xs text-muted-foreground">Все исполнители из смен уже в списке</span>
        )}
      </div>

      {/* Фильтр по компаниям */}
      {chips.length > 2 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {chips.map(o => {
            const active = companyFilter === o.value
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => setCompanyFilter(o.value)}
                className={cn(
                  'inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  active ? 'border-transparent bg-foreground text-background' : 'border-line bg-card text-ink-2 hover:text-foreground',
                )}
              >
                {o.color && <span className="size-1.5 shrink-0 rounded-full" style={{ background: o.color }} />}
                <span className="truncate" title={o.label}>{o.label}</span>
                <span className={cn('tabular shrink-0', active ? 'opacity-70' : 'text-muted-foreground')}>{o.count}</span>
              </button>
            )
          })}
        </div>
      )}

      {loading ? (
        <Spinner label="Загрузка сотрудников..." />
      ) : (
        <div ref={listTopRef} className="scroll-mt-20 overflow-hidden rounded-2xl border border-line">
          {visibleRows.length ? (
            isDesktop ? (
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  <col className="w-[34%]" />
                  <col className="w-[26%]" />
                  <col className="w-[18%]" />
                  <col className="w-[16%]" />
                  <col className="w-12" />
                </colgroup>
                <thead className="bg-surface-2/60">
                  <tr className="border-b border-line text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <th className="py-2.5 pl-3 font-medium">Сотрудник</th>
                    <th className="px-3 py-2.5 font-medium">Компания</th>
                    <th className="px-3 py-2.5 font-medium">Телефон</th>
                    <th className="px-3 py-2.5 font-medium">Пароль</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shownRows.map(r => (
                    <DesktopRow key={r._id} row={r} state={rowState.get(r._id)} onChange={handleRowChange} onDelete={handleDeleteRow} />
                  ))}
                </tbody>
              </table>
            ) : (
              <div>
                {shownRows.map(r => <MobileRow key={r._id} row={r} state={rowState.get(r._id)} onOpen={handleOpenMobile} />)}
              </div>
            )
          ) : (
            <div className="p-10 text-center text-sm text-muted-foreground">
              {rows.length ? 'Никого не нашлось — измените поиск или фильтр' : 'Сотрудников пока нет — они появятся из статистики WMS'}
            </div>
          )}
          <ListPager page={curPage} pageSize={PAGE_SIZE} total={visibleRows.length} onChange={goToPage} />
        </div>
      )}

      {/* Несохранённые изменения — панель прилипает к низу экрана */}
      {changes.total > 0 && (
        <div className="sticky bottom-3 z-20 mt-3">
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-[var(--glass)] p-3 shadow-float backdrop-blur-xl">
            <span className="size-2 shrink-0 rounded-full bg-warning" />
            <div className="min-w-0 flex-1 text-sm">
              <span className="font-medium">Несохранённые изменения</span>
              <span className="text-muted-foreground">
                {[changes.edited && `изменено ${changes.edited}`, changes.removed && `удалено ${changes.removed}`].filter(Boolean).map(s => ' · ' + s).join('')}
              </span>
            </div>
            <Button variant="ghost" onClick={handleDiscard} disabled={saving}><Undo2 className="size-4" /> Отменить</Button>
            <Button onClick={handleSave} disabled={saving}><Save className="size-4" /> {saving ? 'Сохранение…' : 'Сохранить'}</Button>
          </div>
        </div>
      )}
    </SettingCard>
  )
}
