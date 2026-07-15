import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { SettingCard } from './SettingCard'
import { QuickAssignDialog } from './QuickAssignDialog'
import { Users, Upload, Download, X } from 'lucide-react'

function titleCaseFio(str) {
  return (str || '').replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
}

let idCounter = 0
function nextId() { return `_new_${++idCounter}` }

function EmplRow({ row, onChange, onDelete, companiesListId }) {
  return (
    <tr className="border-b last:border-0">
      <td className="p-1.5"><Input className="h-8" value={row.fio} onChange={e => onChange('fio', e.target.value)} placeholder="ФИО" /></td>
      <td className="p-1.5"><Input className="h-8" list={companiesListId} value={row.company} onChange={e => onChange('company', e.target.value)} placeholder="Компания" /></td>
      <td className="p-1.5"><Input className="h-8" value={row.phone || ''} onChange={e => onChange('phone', e.target.value)} placeholder="Телефон" /></td>
      <td className="p-1.5"><Input className="h-8" value={row.password || ''} onChange={e => onChange('password', e.target.value)} placeholder="Пароль" /></td>
      <td className="p-1.5 text-right">
        <Button size="icon" variant="ghost" onClick={onDelete} title="Удалить"><X className="size-3.5" /></Button>
      </td>
    </tr>
  )
}

// Мобильная карточка — те же 4 редактируемых поля, что и в строке таблицы,
// просто в сетке 2×2 вместо 4 колонок (иначе инпуты становятся нечитаемо узкими).
function EmplMobileRow({ row, onChange, onDelete, companiesListId }) {
  return (
    <div className="space-y-1.5 border-b p-2.5 last:border-0">
      <div className="flex items-center gap-1.5">
        <Input className="h-8" value={row.fio} onChange={e => onChange('fio', e.target.value)} placeholder="ФИО" />
        <Button size="icon" variant="ghost" className="shrink-0" onClick={onDelete} title="Удалить"><X className="size-3.5" /></Button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Input className="h-8" list={companiesListId} value={row.company} onChange={e => onChange('company', e.target.value)} placeholder="Компания" />
        <Input className="h-8" value={row.phone || ''} onChange={e => onChange('phone', e.target.value)} placeholder="Телефон" />
      </div>
      <Input className="h-8" value={row.password || ''} onChange={e => onChange('password', e.target.value)} placeholder="Пароль" />
    </div>
  )
}

export function EmployeesCard() {
  const [rows, setRows] = useState([])
  const [allCompanies, setAllCompanies] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [info, setInfo] = useState('Загрузка...')
  const [quickAssign, setQuickAssign] = useState(null)
  const [localSaved, setLocalSaved] = useState(() => new Set())
  const [companyFilter, setCompanyFilter] = useState('__all__')
  const [scanResult, setScanResult] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [upgrading, setUpgrading] = useState(false)
  const fileInputRef = useRef(null)

  const load = () => {
    setLoading(true)
    return withMinDuration(async () => {
      try {
        const res = await api.getEmployees()
        const employees = res.employees || []
        setAllCompanies(res.companies || [])
        setRows(employees.map(e => ({ fio: titleCaseFio(e.fio), company: e.company || '', phone: e.phone || '', password: e.password || '', executorId: e.executorId || null, _id: e.executorId || nextId() })))
        setInfo(employees.length ? `${employees.length} сотрудников · ${(res.companies || []).length} компаний` : 'Список пуст — добавьте вручную или загрузите CSV')
      } catch (err) {
        setAllCompanies([])
        setRows([])
        setInfo(err.message || 'Не удалось загрузить сотрудников')
      }
    }).finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    // «Без компании» — не ждёт ручного клика по «Найти из всех смен»: сразу
    // при открытии Настроек сканируем ВСЕ смены (а не только текущий фетч
    // статистики, у которого «новые сотрудники» — это лишь то, что нашлось
    // в ОДНОМ конкретном обновлении). Раньше здесь был постоянно пустой
    // стаб (`noCompanyList`, `useState([])` без единого вызова сеттера) —
    // честной сверки не было вообще, баннер появлялся только после ручного
    // скана.
    handleScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const noCompanyEmployees = useMemo(() => {
    if (!scanResult) return []
    return scanResult.filter(e => !localSaved.has(`id:${e.executorId}`))
  }, [scanResult, localSaved])

  const doSaveEmpl = async (fio, company, executorId = null) => {
    try {
      const data = await api.saveEmplOne(fio, company, executorId)
      if (!data.ok) { toast.error('Ошибка: ' + (data.error || 'не удалось сохранить')); return }
      toast.success('Сохранено')
      if (executorId) setLocalSaved(prev => new Set([...prev, `id:${executorId}`]))
      setRows(prev => {
        const exists = prev.some(r => r.executorId === executorId)
        return exists
          ? prev.map(r => r.executorId === executorId ? { ...r, fio, company } : r)
          : [{ fio, company, phone: '', password: '', executorId, _id: executorId || nextId() }, ...prev]
      })
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    }
  }

  const handleAddRow = () => setRows(prev => [{ fio: '', company: '', phone: '', password: '', executorId: null, _id: nextId() }, ...prev])
  const handleRowChange = (_id, field, value) => setRows(prev => prev.map(r => r._id === _id ? { ...r, [field]: value } : r))
  const handleDeleteRow = _id => setRows(prev => prev.filter(r => r._id !== _id))

  const handleImportCsv = e => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const text = ev.target.result || ''
      const csv = text.startsWith('﻿') ? text.slice(1) : text
      const sep = csv.includes(';') ? ';' : ','
      const imported = []
      for (const line of csv.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const cols = trimmed.split(sep).map(c => c.trim().replace(/^"|"$/g, ''))
        if (cols[0]) imported.push({ fio: titleCaseFio(cols[0]), company: cols[1] || '', phone: cols[2] || '', password: cols[3] || '', executorId: null, _id: nextId() })
      }
      setRows(imported)
      toast.info('Импортировано ' + imported.length + ' строк')
    }
    reader.readAsText(file, 'utf-8')
    e.target.value = ''
  }

  const handleExportCsv = () => {
    if (!rows.length) { toast.error('Нет данных для экспорта'); return }
    const clean = v => String(v || '').replace(/[\r\n;]/g, ' ')
    const csv = rows.map(r => [clean(r.fio), clean(r.company), clean(r.phone), clean(r.password)].join(';')).join('\r\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'employees.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const handleSave = async () => {
    const all = rows.filter(r => r.fio.trim() && r.executorId).map(r => ({ fio: r.fio, company: r.company, phone: r.phone || '', password: r.password || '', executorId: r.executorId }))
    try {
      const res = await api.saveEmployeesAll(all)
      if (!res.ok) { toast.error('Ошибка: ' + res.error); return }
      toast.success(`Сохранено ${all.length} сотрудников`)
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    }
  }

  const handleUpgradeIds = async () => {
    setUpgrading(true)
    try {
      const data = await api.upgradeFioIds()
      toast.success(data.upgraded > 0 ? `Обновлено UUID: ${data.upgraded}` : 'Все записи уже с реальными UUID')
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setUpgrading(false)
    }
  }

  const handleScan = async () => {
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

  const q = search.trim().toLowerCase()
  const filteredRows = rows.filter(r => {
    if (companyFilter === '__none__' && r.company) return false
    if (companyFilter !== '__all__' && companyFilter !== '__none__' && r.company !== companyFilter) return false
    if (!q) return true
    return r.fio.toLowerCase().includes(q) || r.company.toLowerCase().includes(q) || String(r.phone || '').toLowerCase().includes(q)
  })

  const filterChips = [{ value: '__all__', label: 'Все' }, ...allCompanies.map(c => ({ value: c, label: c })), { value: '__none__', label: 'Без компании' }]

  return (
    <SettingCard icon={Users} title="Список сотрудников" subtitle={info}>
      {quickAssign && (
        <QuickAssignDialog
          fio={quickAssign.fio}
          companies={allCompanies}
          onOpenChange={open => !open && setQuickAssign(null)}
          onSave={async company => { const { fio, executorId } = quickAssign; setQuickAssign(null); await doSaveEmpl(fio, company, executorId) }}
        />
      )}

      {noCompanyEmployees.length > 0 && (
        <div className="mb-4 space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="rounded-full bg-warning/20 px-2 py-0.5 text-xs">{noCompanyEmployees.length}</span>
            Без компании (по всем сменам)
            <button className="ml-auto text-muted-foreground hover:text-foreground" title="Закрыть результаты скана" onClick={() => setScanResult(null)}>
              <X className="size-3.5" />
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {noCompanyEmployees.map(e => (
              <button key={e.executorId} className="rounded-full border bg-card px-2.5 py-1 text-xs hover:border-primary" onClick={() => setQuickAssign({ fio: e.fio, executorId: e.executorId })}>
                {e.fio}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mb-3 flex flex-wrap gap-2">
        <Input className="w-56" placeholder="Поиск..." value={search} onChange={e => setSearch(e.target.value)} />
        <Button size="sm" variant="secondary" onClick={handleAddRow}>+ Добавить</Button>
        <Button size="sm" variant="secondary" asChild>
          <label className="cursor-pointer">
            <Upload className="size-3.5" /> CSV
            <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={handleImportCsv} />
          </label>
        </Button>
        <Button size="sm" variant="secondary" onClick={handleExportCsv}><Download className="size-3.5" /> Экспорт</Button>
        <Button size="sm" variant="secondary" disabled={scanning} onClick={handleScan}>{scanning ? 'Сканирование...' : 'Найти из всех смен'}</Button>
        <Button size="sm" variant="secondary" disabled={upgrading} onClick={handleUpgradeIds}>{upgrading ? 'Привязка...' : 'Привязать UUID'}</Button>
        <Button size="sm" onClick={handleSave}>Сохранить</Button>
      </div>

      {scanResult !== null && scanResult.length === 0 && (
        <div className="mb-3 text-sm text-muted-foreground">Все исполнители из всех смен уже в списке</div>
      )}

      {allCompanies.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {filterChips.map(o => (
            <button
              key={o.value}
              onClick={() => setCompanyFilter(o.value)}
              className={cn('rounded-full border px-2.5 py-1 text-xs', companyFilter === o.value ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground')}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <Spinner label="Загрузка сотрудников..." />
      ) : (
        <div className="rounded-md border">
          {filteredRows.length ? (
            <>
              {/* Мобильные карточки — до md (768px) */}
              <div className="md:hidden">
                {filteredRows.map(r => (
                  <EmplMobileRow key={r._id} row={r} companiesListId="empl-companies-dl" onChange={(f, v) => handleRowChange(r._id, f, v)} onDelete={() => handleDeleteRow(r._id)} />
                ))}
              </div>

              {/* Десктопная таблица — от md и шире */}
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="p-2 text-left font-medium">ФИО</th>
                      <th className="p-2 text-left font-medium">Компания</th>
                      <th className="p-2 text-left font-medium">Телефон</th>
                      <th className="p-2 text-left font-medium">Пароль</th>
                      <th className="w-10" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map(r => (
                      <EmplRow key={r._id} row={r} companiesListId="empl-companies-dl" onChange={(f, v) => handleRowChange(r._id, f, v)} onDelete={() => handleDeleteRow(r._id)} />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="p-6 text-center text-muted-foreground">{rows.length ? 'Ничего не найдено' : 'Нет сотрудников — добавьте вручную или загрузите CSV'}</div>
          )}
          <datalist id="empl-companies-dl">
            {allCompanies.map(c => <option key={c} value={c} />)}
          </datalist>
        </div>
      )}
    </SettingCard>
  )
}
