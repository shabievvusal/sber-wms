import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { RefreshCw, FileDown, FileText, Settings2, Loader2 } from 'lucide-react'
import * as api from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import { loadActConstants, loadCompanyFullNames } from '../shift-plan/actConstants'
import { buildActWorkbook } from '../shift-plan/actTemplate'
import { buildJustificationWorkbook } from './justification'
import { ImportPanel } from './ImportPanel'
import { ShiftTable } from './ShiftTable'
import { SettingsPanel } from './SettingsPanel'
import { buildAccountIndex, currentShift, fmtHours, fmtTime, SHIFT_LABELS, STATUS_META, todayStr } from './format'

const selectClass = 'h-8 rounded-md border border-input bg-transparent px-2 text-sm'

function groupByCompany(list) {
  const map = new Map()
  for (const r of list) {
    if (!map.has(r.company)) map.set(r.company, [])
    map.get(r.company).push(r)
  }
  return map
}

// Мотивация аутсорса (2026-09-25). Подрядчик к сроку сообщает, под какой
// учёткой работает каждый человек из его акта; часы в акт считаются по
// выработке учётки (СЗ и вес) — см. backend-dotnet/Services/MotivationService.cs.
export default function MotivationPage() {
  const { user } = useAuth()
  const canEditSettings = user?.role === 'admin' || user?.role === 'developer'
  const [date, setDate] = useState(todayStr())
  const [shift, setShift] = useState(currentShift())
  const [employees, setEmployees] = useState([])
  const [companies, setCompanies] = useState([])
  const [calc, setCalc] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    api.getEmployees()
      .then(data => { setEmployees(data.employees || []); setCompanies(data.companies || []) })
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setCalc(await api.getMotivationCalculation(date, shift))
    } catch (err) {
      setCalc(null)
      setError(err.message || 'Не удалось загрузить')
    }
    setLoading(false)
  }, [date, shift])

  useEffect(() => { load() }, [load])

  const accountIndex = useMemo(() => buildAccountIndex(employees), [employees])
  const rows = calc?.rows || []
  const byCompany = useMemo(() => groupByCompany(rows), [rows])
  const unmappedByCompany = useMemo(() => groupByCompany(calc?.unmapped || []), [calc])

  const statusCounts = useMemo(() => {
    const counts = {}
    for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1
    return counts
  }, [rows])
  const totalHours = rows.reduce((s, r) => s + (r.hours || 0), 0)

  // Учётки не прислали — вносим в смену тех, кто работал, по статистике:
  // ФИО = имя учётки, компания — из справочника, срок подачи не действует.
  const addFromStats = async list => {
    try {
      await api.addMotivationPeople({
        date,
        shift,
        fromStats: true,
        people: list.map(r => ({
          company: r.company === '—' ? '' : r.company,
          fio: r.executorName || r.executorId,
          role: 'picker',
          executorId: r.executorId,
          executorName: r.executorName,
        })),
      })
      toast.success(`Внесено в акт: ${list.length}`)
      load()
    } catch (err) {
      toast.error(err.message)
    }
  }

  const shiftSuffix = `${date}_${shift === 'night' ? 'ночь' : 'день'}`

  // По файлу на компанию, все — в одном ZIP. buildFile(ExcelJS, company,
  // list) → [имя файла, workbook].
  const downloadZip = async (zipName, buildFile) => {
    if (!rows.length) return
    setGenerating(true)
    try {
      const ExcelJS = (await import('exceljs')).default
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()
      for (const [company, list] of byCompany) {
        const [fileName, wb] = buildFile(ExcelJS, company, list)
        zip.file(fileName, await wb.xlsx.writeBuffer())
      }
      const blob = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = zipName
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      toast.error(err.message || 'Не удалось сформировать файлы')
    }
    setGenerating(false)
  }

  const downloadActs = () => {
    const constants = loadActConstants()
    const fullNames = loadCompanyFullNames()
    const [y, m, d] = date.split('-').map(Number)
    const dateObj = new Date(Date.UTC(y, m - 1, d))
    return downloadZip(`Акты_мотивация_${shiftSuffix}.zip`, (ExcelJS, company, list) => [
      `Акт ${company || 'без компании'} ${date}.xlsx`,
      buildActWorkbook(ExcelJS, {
        customerName: constants.customerName,
        contractorFullName: fullNames[company]?.trim() || company || '—',
        warehouseAddress: constants.warehouseAddress,
        warehouseType: constants.warehouseType,
        warehouseCategory: constants.warehouseCategory,
        date: dateObj,
        shift,
        employees: list.map(r => ({ name: r.fio, hours: r.hours || 0 })),
      }),
    ])
  }

  const downloadJustification = () =>
    downloadZip(`Обоснование_часов_${shiftSuffix}.zip`, (ExcelJS, company, list) => [
      `Обоснование ${company || 'без компании'} ${date}.xlsx`,
      buildJustificationWorkbook(ExcelJS, {
        company, date, shift, rows: list, settings: calc.settings, deadline: calc.deadline,
      }),
    ])

  return (
    <div className="space-y-4 p-4">
      <datalist id="motivation-accounts">
        {employees.filter(e => e.executorId).map(e => (
          <option key={e.executorId} value={e.executorId}>{e.fio}{e.company ? ` · ${e.company}` : ''}</option>
        ))}
      </datalist>

      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm">
          <span className="block text-xs text-muted-foreground">Дата смены</span>
          <DatePicker value={date} onChange={e => setDate(e.target.value)} className="h-8 w-36" />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block text-xs text-muted-foreground">Смена</span>
          <select className={selectClass} value={shift} onChange={e => setShift(e.target.value)}>
            <option value="day">День</option>
            <option value="night">Ночь</option>
          </select>
        </label>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Пересчитать
        </Button>
        <Button size="sm" onClick={downloadActs} disabled={generating || !rows.length}>
          <FileDown className="size-4" /> Акты с часами (ZIP)
        </Button>
        <Button size="sm" variant="outline" onClick={downloadJustification} disabled={generating || !rows.length}>
          <FileText className="size-4" /> Обоснование (ZIP)
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setShowSettings(v => !v)}>
          <Settings2 className="size-4" /> Нормы
        </Button>
      </div>

      {showSettings && calc?.settings && (
        <SettingsPanel
          settings={calc.settings}
          canEdit={canEditSettings}
          onSaved={() => load()}
        />
      )}

      {error && <div className="text-sm text-destructive">{error}</div>}

      {calc && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-lg border bg-card p-3">
            <div className="text-xs text-muted-foreground">Людей в актах</div>
            <div className="text-xl font-semibold">{rows.length}</div>
            <div className="text-xs text-muted-foreground">{SHIFT_LABELS[shift]} · {date}</div>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <div className="text-xs text-muted-foreground">Часов в акт</div>
            <div className="text-xl font-semibold">{fmtHours(totalHours)}</div>
            <div className="text-xs text-muted-foreground">из {fmtHours(rows.length * (calc.settings?.baseHours || 0))} при полной норме</div>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <div className="text-xs text-muted-foreground">Срок подачи учёток</div>
            <div className="text-xl font-semibold">{fmtTime(calc.deadline)}</div>
            <div className="text-xs text-muted-foreground">
              {calc.settings?.strictDeadline ? 'после срока — 0 часов' : 'опоздание только отмечается'}
            </div>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <div className="text-xs text-muted-foreground">Статусы</div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
              {Object.entries(statusCounts).map(([status, count]) => (
                <span key={status}>{STATUS_META[status]?.[0] || status}: <strong>{count}</strong></span>
              ))}
              {rows.length === 0 && <span className="text-muted-foreground">список пуст</span>}
            </div>
          </div>
        </div>
      )}

      <ImportPanel date={date} shift={shift} companies={companies} accountIndex={accountIndex} onSaved={load} />

      {[...byCompany.entries()].map(([company, list]) => (
        <ShiftTable key={company} company={company} rows={list} accountIndex={accountIndex} onChanged={load} />
      ))}

      {calc?.unmapped?.length > 0 && (
        <div className="space-y-3">
          <div className="text-sm">
            <span className="font-semibold">
              {rows.length ? 'Учётки с отбором, но без человека в акте' : 'Расчёт по статистике — учётки не внесены'}
            </span>
            <span className="ml-2 text-xs text-muted-foreground">
              {rows.length
                ? 'под ними работали, но подрядчик их не сообщил — в акт не попадают'
                : 'учётка считается одним человеком, компания — из справочника сотрудников; в акт не попадает'}
            </span>
          </div>
          {[...unmappedByCompany.entries()].map(([company, list]) => (
            <ShiftTable key={company} company={company} rows={list} readOnly onAdd={addFromStats} />
          ))}
        </div>
      )}
    </div>
  )
}
