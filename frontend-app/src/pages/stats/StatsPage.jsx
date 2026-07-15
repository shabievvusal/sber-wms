import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { getStoredToken, fetchDataViaBrowser, fetchPlacementViaBrowser, fetchRemainsViaBrowser } from '@/lib/wmsFetch'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { StatsToolbar } from './StatsToolbar'
import { StatsCard } from './StatsCard'
import { StatsCards } from './StatsCards'
import { CompanyFilter } from './CompanyFilter'
import { HourlyChart } from './HourlyChart'
import { CompanySummaryTable } from './CompanySummaryTable'
import { MonthlyCompanySummaryTable } from './MonthlyCompanySummaryTable'
import { HourlyEmployeeTable } from './HourlyEmployeeTable'
import { MonthlyEmployeeTable } from './MonthlyEmployeeTable'
import { MissingWeightPanel } from './MissingWeightPanel'
import {
  ACTIONS_BY_ROLE, HE_MODES, IDLE_THRESHOLD_DEFAULT, ALLOWED_IDLE_DEFAULT,
  LS_ALLOWED_IDLE, LS_HE_MODE, LS_IDLE_THRESHOLD,
} from './constants'
import {
  buildFullZoneCatalog, buildZoneCatalog, computeWorkedMinutesInShift, getCurrentShiftInfo, getElapsedShiftMinutes,
  getShiftHours, isKdkZoneKey, zoneColor,
} from './format'
import { Download } from 'lucide-react'

const API_SUMMARY_BY_OP = {
  selection: (dateStr, shift, idleThresholdMinutes) => api.getDateSummaryFull(dateStr, { shift, idleThresholdMinutes }),
  placement: (dateStr, shift) => api.getPlacementDateSummary(dateStr, { shift }),
  receiving: (dateStr, shift) => api.getReceivingDateSummary(dateStr, { shift }),
  remains: (dateStr, shift) => api.getRemainsDateSummary(dateStr, { shift }),
}

const LS_AUTO_FETCH_ENABLED = 'vs_auto_fetch_enabled'

function readLs(key, fallback) {
  try { return localStorage.getItem(key) || fallback } catch { return fallback }
}

const hexToArgb = h => 'FF' + h.replace('#', '').padEnd(6, '0').toUpperCase()

// Перенесено из оригинала (frontend/app/src/pages/stats/StatsPage.jsx +
// StatsToolbar/StatsCards/CompanyFilter/HourlyChart/CompanySummaryTable/
// MonthlyCompanySummaryTable/HourlyEmployeeTable/MonthlyEmployeeTable) —
// главная страница приложения (маршрут «/» в оригинале), самая большая
// перенесённая страница. По прямому указанию пользователя (2026-07-12,
// «весь раздел полностью возьми») перенесена целиком, включая то, что
// первый заход сознательно откладывал: XLSX-экспорт (exceljs, 3 функции),
// баннер «новые сотрудники из WMS», фильтр по зоне на вкладке «За период»,
// ролевой гейтинг действий тулбара. См. PLAN.md за деталями.
//
// Единственное, что осталось не перенесено — полный клиентский пересчёт
// статистики из сырых items (statsCalc.js, ~511 строк): здесь потребляется
// только уже готовый агрегат с бэкенда (summary-only путь), как и у уже
// перенесённых ReportsPage/AnalysisPage — этот путь не производит другого
// видимого результата, чем summary-only, просто дублирует его на клиенте
// (см. PLAN.md, «statsCalc.js дублирует storage.js»).
export default function StatsPage() {
  const { user: currentUser } = useAuth()
  const initialShiftInfo = getCurrentShiftInfo()
  const [dateStr, setDateStr] = useState(initialShiftInfo.dateStr)
  const [shift, setShift] = useState(initialShiftInfo.shift)
  const [operation, setOperation] = useState('selection')
  const [fetchHourFrom, setFetchHourFrom] = useState('9')
  const [fetchHourTo, setFetchHourTo] = useState('21')

  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [fetching, setFetching] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [engineNote, setEngineNote] = useState('')
  const [newEmployees, setNewEmployees] = useState([])
  const autoFetchEnabled = readLs(LS_AUTO_FETCH_ENABLED, '0') === '1'

  const [filterCompany, setFilterCompany] = useState('__all__')
  const [heTableMode, setHeTableMode] = useState(() => readLs(LS_HE_MODE, 'sz'))
  const [idleThresholdMinutes, setIdleThresholdMinutes] = useState(() => Number(readLs(LS_IDLE_THRESHOLD, IDLE_THRESHOLD_DEFAULT)))
  const [allowedIdleMinutes, setAllowedIdleMinutes] = useState(() => Number(readLs(LS_ALLOWED_IDLE, ALLOWED_IDLE_DEFAULT)))
  const idleDebounceRef = useRef(null)
  const monthlyExportRef = useRef(null)

  const actions = ACTIONS_BY_ROLE[currentUser?.role] || []
  const canEditThresholds = actions.includes('edit_thresholds')

  const isOperationStats = operation !== 'selection'
  const effectiveHeMode = isOperationStats && heTableMode !== 'sz' && heTableMode !== 'monthly' ? 'sz' : heTableMode

  useEffect(() => { try { localStorage.setItem(LS_HE_MODE, heTableMode) } catch { /* ignore */ } }, [heTableMode])
  useEffect(() => { try { localStorage.setItem(LS_IDLE_THRESHOLD, String(idleThresholdMinutes)) } catch { /* ignore */ } }, [idleThresholdMinutes])
  useEffect(() => { try { localStorage.setItem(LS_ALLOWED_IDLE, String(allowedIdleMinutes)) } catch { /* ignore */ } }, [allowedIdleMinutes])

  const loadSummary = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true)
    await withMinDuration(async () => {
      try {
        const data = await API_SUMMARY_BY_OP[operation](dateStr, shift, idleThresholdMinutes)
        setSummary(data)
        setError('')
      } catch (err) {
        setSummary(null)
        setError(err.message || 'Не удалось загрузить статистику')
      }
    })
    setLastUpdated(new Date().toISOString())
    setLoading(false)
  }, [dateStr, shift, operation, idleThresholdMinutes])

  useEffect(() => { loadSummary() }, [dateStr, shift, operation]) // eslint-disable-line react-hooks/exhaustive-deps

  // Полный список компаний из реестра сотрудников (Настройки → Сотрудники),
  // не только те, что встретились в статистике за просматриваемый день/смену
  // (пользователь: «не вижу почему других компании в фильтре, хоть она и есть
  // в списках сотрудников» — 2026-07-15). Загружается один раз при открытии
  // страницы и объединяется с компаниями из текущей сводки ниже — так
  // компания видна в фильтре даже если у неё сегодня не было ни одной
  // операции (или она вообще ещё не появлялась в статистике).
  const [registryCompanies, setRegistryCompanies] = useState([])
  useEffect(() => {
    api.getEmployees().then(data => setRegistryCompanies(data?.companies || [])).catch(() => {})
  }, [])

  // idleThresholdMinutes меняет серверный расчёт простоев — перезапрашиваем
  // с debounce 400мс, как и в оригинале (allowedIdleMinutes — чисто
  // клиентская арифметика, рефетч не нужен). Пропускаем самый первый вызов —
  // начальную загрузку уже делает эффект выше.
  const isFirstIdleEffect = useRef(true)
  useEffect(() => {
    if (isFirstIdleEffect.current) { isFirstIdleEffect.current = false; return }
    clearTimeout(idleDebounceRef.current)
    idleDebounceRef.current = setTimeout(() => loadSummary({ silent: true }), 400)
    return () => clearTimeout(idleDebounceRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idleThresholdMinutes])

  // Приоритет источника — как в оригинальном runFetchData (AppContext.jsx):
  // если есть настоящий WMS-токен, тянем комплектацию/размещение/остатки
  // напрямую из браузера (параллельно, ошибка одного источника не валит
  // остальные); без токена — прежний same-origin путь без изменений.
  // «Новые сотрудники из WMS» — реальный результат updateNamesRegistry на
  // бэкенде (см. save-fetched-data), пробрасывается через fetchDataViaBrowser.
  const handleFetch = async () => {
    setFetching(true)
    setError('')
    const token = getStoredToken()
    try {
      if (token) {
        const [y, m, d] = dateStr.split('-').map(Number)
        const clampH = h => Math.max(0, Math.min(23, h))
        const fromH = Number(fetchHourFrom)
        const toH = Number(fetchHourTo)
        let fromDate, toDate
        if (shift === 'night' && clampH(fromH) >= clampH(toH)) {
          const next = new Date(y, m - 1, d)
          next.setDate(next.getDate() + 1)
          fromDate = new Date(y, m - 1, d, clampH(fromH), 0, 0, 0)
          toDate = new Date(next.getFullYear(), next.getMonth(), next.getDate(), Math.max(0, clampH(toH) - 1), 59, 59, 999)
        } else {
          fromDate = new Date(y, m - 1, d, clampH(fromH), 0, 0, 0)
          toDate = new Date(y, m - 1, d, Math.max(clampH(fromH), clampH(toH) - 1), 59, 59, 999)
        }
        const opts = { operationCompletedAtFrom: fromDate.toISOString(), operationCompletedAtTo: toDate.toISOString() }

        const [selectionRes, placementRes, remainsRes] = await Promise.all([
          fetchDataViaBrowser(token, opts),
          fetchPlacementViaBrowser(token, { dateFrom: opts.operationCompletedAtFrom, dateTo: opts.operationCompletedAtTo }).catch(err => ({ __error: err })),
          fetchRemainsViaBrowser(token, { dateFrom: opts.operationCompletedAtFrom, dateTo: opts.operationCompletedAtTo }).catch(err => ({ __error: err })),
        ])
        const placementText = placementRes?.__error ? ' · размещение не загружено' : ` · размещение: ${placementRes.fetched ?? '?'}/${placementRes.added ?? '?'}`
        const remainsText = remainsRes?.__error ? ' · остатки не загружены' : ` · остатки: ${remainsRes.fetched ?? '?'}/${remainsRes.added ?? '?'}`
        toast.success(`Комплектация: получено ${selectionRes.fetched ?? '?'}, добавлено ${selectionRes.added ?? '?'}${placementText}${remainsText}`)
        const enginePart = selectionRes.engine === 'dotnet' ? '.NET' : selectionRes.engine === 'node' ? 'Node' : (selectionRes.engine || 'Браузер')
        const totalMsPart = selectionRes.timings?.totalMs ? ` · итого ${(selectionRes.timings.totalMs / 1000).toFixed(1)}с` : ''
        setEngineNote(`${enginePart}${totalMsPart} · комплектация +${selectionRes.added ?? 0}`)
        if (selectionRes.newEmployees?.length) setNewEmployees(selectionRes.newEmployees)
      } else {
        const res = await api.fetchData({ dateStr, shift, fromHour: Number(fetchHourFrom), toHour: Number(fetchHourTo) })
        toast.success('Данные обновлены')
        setEngineNote(res?.duration != null ? `Node · итого ${(res.duration / 1000).toFixed(1)}с · получено ${res.count ?? '?'}` : '')
      }
    } catch (err) {
      setError(err.message || 'Не удалось обновить данные')
      toast.error('Ошибка обновления: ' + (err.message || 'WMS недоступен'))
    }
    await loadSummary({ silent: true })
    setFetching(false)
  }
  const handleRequestFetch = async () => {
    try { await api.requestFetch(); toast.success('Запрос отправлен киоск-устройству') }
    catch (err) { toast.error('Ошибка: ' + (err.message || 'не удалось отправить запрос')) }
  }
  // В оригинале «Перепроверить» — тот же `runFetchData`, что и «Обновить
  // данные» (второй параметр `forceRecheck` там принимается, но нигде не
  // читается дальше по коду — де-факто это одна и та же операция под другой
  // кнопкой/иконкой). Раньше здесь была отдельная, куда более слабая ветка
  // (просто тихий перечитывание уже сохранённой сводки, без единого реального
  // запроса к WMS) — расхождение с оригиналом, из-за которого кнопка ничего
  // не обновляла по факту. Приведено к 1-в-1: тот же реальный фетч.
  const handleRecheck = () => handleFetch()
  const handleAddNewEmployees = async () => {
    try {
      const data = await api.addNewEmployees(newEmployees)
      setNewEmployees([])
      toast.success(`Добавлено сотрудников: ${data.added ?? newEmployees.length}`)
    } catch (err) {
      toast.error('Ошибка: ' + (err.message || 'не удалось добавить сотрудников'))
    }
  }
  const handleDismissNewEmployees = () => setNewEmployees([])

  const companies = useMemo(() => {
    const rows = summary?.hourlyByEmployee?.rows || []
    const fromRows = rows.map(r => r.company).filter(Boolean).filter(c => c !== '—')
    return [...new Set([...fromRows, ...registryCompanies])].sort((a, b) => a.localeCompare(b, 'ru'))
  }, [summary, registryCompanies])

  // Каталог зон для фильтра «За период» (MonthlyEmployeeTable) — тоже без
  // хардкода: список зон, реально встретившихся в уже загруженной сводке
  // дня (не привязан к текущему фильтру компании — это отдельный запрос за
  // произвольный диапазон дат).
  const dayZoneCatalog = useMemo(() => buildFullZoneCatalog(summary?.hourlyByEmployee?.rows || []), [summary])

  const mergedEmployeeRows = useMemo(() => {
    const rows = summary?.hourlyByEmployee?.rows || []
    return rows
      .filter(r => {
        if (filterCompany === '__all__') return true
        if (filterCompany === '__none__') return !r.company || r.company === '—'
        return r.company === filterCompany
      })
      .map(r => ({
        ...r,
        _idleTotalMinutes: summary?.idlesByEmployee?.[r.executorId]?.totalMinutes || 0,
        _idleIntervals: summary?.idlesByEmployee?.[r.executorId]?.intervals || null,
        _weightStorage: summary?.weightByEmployee?.[r.executorId]?.storage || 0,
        _weightKdk: summary?.weightByEmployee?.[r.executorId]?.kdk || 0,
      }))
  }, [summary, filterCompany])

  const shiftLabel = shift === 'night' ? 'Ночь' : 'День'
  const hours = getShiftHours(shift)

  // «Пики по часам» должны учитывать фильтр по компании (CompanyFilter) —
  // не готовый агрегат с бэкенда (`summary.hourly`, всегда по всем
  // компаниям), а пересчёт из уже отфильтрованных `mergedEmployeeRows`.
  const chartHourly = useMemo(() => hours.map(h => {
    let storageOps = 0, kdkOps = 0, storageEmployees = 0, kdkEmployees = 0
    for (const r of mergedEmployeeRows) {
      const v = r.byHour?.[h] || 0
      if (!v) continue
      if (!isOperationStats && isKdkZoneKey(r.byHourZone?.[h])) { kdkOps += v; kdkEmployees += 1 }
      else { storageOps += v; storageEmployees += 1 }
    }
    return { hour: h, storageOps, kdkOps, storageEmployees, kdkEmployees }
  }), [mergedEmployeeRows, hours, isOperationStats])

  // ─── XLSX-экспорт «Сотрудники по часам» / «Простои» ──────────────────────
  // Перенесено из оригинала (StatsPage.jsx: handleExportHourly/
  // handleExportIdles) — структура/цвета/шапка воспроизведены дословно,
  // источник строк — `mergedEmployeeRows` (уже отфильтрованные по компании,
  // в оригинале экспорт берёт `hourlyByEmployee.allRows`, т.е. без фильтра
  // компании — здесь экспортируется то, что реально показано на экране,
  // осознанная небольшая адаптация).
  const handleExportHourly = async () => {
    if (!mergedEmployeeRows.length) { toast.info('Нет данных для экспорта'); return }
    if (effectiveHeMode === 'idles') { toast.info('Переключитесь в режим «По СЗ» или «По часам» для экспорта'); return }
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    wb.creator = 'ВС'; wb.created = new Date()
    const ws = wb.addWorksheet('Сотрудники по часам')

    const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
    const SUBHDR_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1D5DB' } }
    const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }
    const BORDER = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
    const ALIGN = { horizontal: 'center', vertical: 'middle' }

    const shiftLbl = shift === 'night' ? 'Ночная смена' : 'Дневная смена'
    const modeLbl = effectiveHeMode === 'sz' ? 'По СЗ' : 'По часам'
    const dateLbl = dateStr ? dateStr.split('-').reverse().join('.') : ''

    const C_CO = 1, C_NAME = 2
    const C_H0 = 3, C_HN = 2 + hours.length
    const C_TOT = C_HN + 1, C_WORK = C_TOT + 1, C_SP = C_WORK + 1
    const C_WS = C_SP + 1, C_WK = C_WS + 1, C_WT = C_WK + 1
    const NCOLS = C_WT

    ws.addRow([`Сотрудники по часам • ${modeLbl} • ${dateLbl} • ${shiftLbl}`])
    if (NCOLS > 1) ws.mergeCells(1, 1, 1, NCOLS)
    ws.getRow(1).getCell(1).style = { font: { bold: true, size: 13, color: { argb: 'FFFFFFFF' } }, fill: HEADER_FILL, alignment: { horizontal: 'left', vertical: 'middle' } }
    ws.getRow(1).height = 26

    const addLT = text => {
      ws.addRow(new Array(NCOLS).fill(null))
      const rn = ws.lastRow.number
      if (NCOLS > 1) ws.mergeCells(rn, 1, rn, NCOLS)
      ws.getRow(rn).getCell(1).value = text
      ws.getRow(rn).getCell(1).style = { font: { bold: true, size: 11, color: { argb: 'FFFFFFFF' } }, fill: HEADER_FILL, alignment: { horizontal: 'left', vertical: 'middle' } }
      ws.getRow(rn).height = 18; ws.getRow(rn).outlineLevel = 1
    }
    const addLR = (argb, name, desc) => {
      ws.addRow(new Array(NCOLS).fill(null))
      const rn = ws.lastRow.number
      if (NCOLS > 3) ws.mergeCells(rn, 3, rn, NCOLS)
      const r = ws.getRow(rn)
      if (argb) r.getCell(1).style = { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb } }, border: BORDER, alignment: { vertical: 'middle', horizontal: 'center' } }
      r.getCell(2).value = name; r.getCell(2).style = { font: { bold: true }, alignment: { vertical: 'middle' } }
      r.getCell(3).value = desc; r.getCell(3).style = { alignment: { vertical: 'middle', wrapText: true } }
      r.height = Math.max(18, Math.ceil((desc || '').length / 70) * 16); r.outlineLevel = 1
    }
    const addLS = () => { ws.addRow(new Array(NCOLS).fill(null)); ws.getRow(ws.lastRow.number).height = 6; ws.getRow(ws.lastRow.number).outlineLevel = 1 }

    if (effectiveHeMode === 'sz') {
      addLT('Легенда — цвета ячеек (режим «По СЗ»)')
      addLR('FFFECACA', '< 50 задач/час', 'Низкая производительность')
      addLR('FFFEF08A', '50–75 задач/час', 'Средняя производительность')
      addLR('FFFFFFFF', '> 75 задач/час', 'Высокая производительность')
    } else {
      addLT('Легенда — цвета ячеек (режим «По часам», доминирующая зона)')
      for (const z of buildZoneCatalog(mergedEmployeeRows)) addLR(hexToArgb(z.light), z.label, '')
    }
    addLS(); addLT('Описание колонок')
    addLR(null, 'Компания', 'Название компании-подрядчика сотрудника')
    addLR(null, 'Сотрудник', 'ФИО исполнителя')
    addLR(null, 'ЧЧ', 'Кол-во задач за данный час смены; под числом — вес (кг)')
    addLR(null, 'Итого', 'Суммарное кол-во задач за смену')
    addLR(null, 'В работе', 'Время в работе: длительность смены − суммарные простои (ЧЧ:ММ)')
    addLR(null, 'Старт/Пик', 'Верхняя строка — первая операция смены; нижняя — последняя')
    addLR(null, 'Вес ХР', 'Суммарный вес в зоне хранения (кг)')
    addLR(null, 'Вес КДК', 'Суммарный вес в зоне КДК (кг)')
    addLR(null, 'Вес итог', 'Общий суммарный вес (хранение + КДК, кг)')
    addLS()

    ws.addRow(new Array(NCOLS).fill(null)); ws.getRow(ws.lastRow.number).height = 4

    const grpRN = ws.lastRow.number + 1
    const grpRow = ws.addRow(new Array(NCOLS).fill(''))
    const subRN = ws.lastRow.number + 1
    const subRow = ws.addRow(new Array(NCOLS).fill(''))

    const gHdr = (argb = 'FF374151') => ({ font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb } }, border: BORDER, alignment: ALIGN })
    const sHdr = { font: { bold: true }, fill: SUBHDR_FILL, border: BORDER, alignment: ALIGN }

    for (const [col, label] of [[C_CO, 'Компания'], [C_NAME, 'Сотрудник'], [C_TOT, 'Итого'], [C_WORK, 'В работе'], [C_SP, 'Старт/Пик'], [C_WS, 'Вес ХР'], [C_WK, 'Вес КДК'], [C_WT, 'Вес итог']]) {
      ws.mergeCells(grpRN, col, subRN, col)
      grpRow.getCell(col).value = label; grpRow.getCell(col).style = gHdr()
    }
    if (hours.length > 0) {
      if (hours.length > 1) ws.mergeCells(grpRN, C_H0, grpRN, C_HN)
      grpRow.getCell(C_H0).value = 'Задачи по часам'; grpRow.getCell(C_H0).style = gHdr('FF1E3A5F')
      hours.forEach((col, i) => {
        const s = (col + 23) % 24
        subRow.getCell(C_H0 + i).value = `${String(s).padStart(2, '0')}–${String(col % 24).padStart(2, '0')}`
        subRow.getCell(C_H0 + i).style = sHdr
      })
    }
    grpRow.height = 20; subRow.height = 18
    ws.views = [{ state: 'frozen', ySplit: subRN }]

    const wgKg = g => { const v = Number(g) || 0; return v > 0 ? +(v / 1000).toFixed(1) : '' }
    const szFill = v => v < 50 ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFECACA' } }
      : v <= 75 ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF08A' } } : null
    const zFill = k => k ? { type: 'pattern', pattern: 'solid', fgColor: { argb: hexToArgb(zoneColor(k).light) } } : null

    const shiftMinutes = getElapsedShiftMinutes(dateStr, shift)
    const sortedRows = [...mergedEmployeeRows].sort((a, b) => (a.company || '').localeCompare(b.company || '', 'ru') || b.total - a.total)
    for (const r of sortedRows) {
      const workedMin = computeWorkedMinutesInShift(r._idleTotalMinutes || 0, allowedIdleMinutes, shiftMinutes)
      const fmt2 = n => String(Math.floor(n || 0)).padStart(2, '0')
      const fmtT = iso => iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—'

      const rowData = new Array(NCOLS).fill('')
      rowData[C_CO - 1] = r.company || '—'
      rowData[C_NAME - 1] = r.name
      hours.forEach((col, i) => {
        const v = r.byHour?.[col] || 0
        const wg = r.weightByHour?.[col] || 0
        if (v > 0) rowData[C_H0 - 1 + i] = wg > 0 ? `${v}\n${+(wg / 1000).toFixed(1)} кг` : v
      })
      rowData[C_TOT - 1] = r.total || 0
      rowData[C_WORK - 1] = workedMin > 0 ? `${fmt2(workedMin / 60)}:${fmt2(workedMin % 60)}` : '—'
      rowData[C_SP - 1] = `${fmtT(r.firstAt)}\n${fmtT(r.lastAt)}`
      rowData[C_WS - 1] = wgKg(r._weightStorage) || '—'
      rowData[C_WK - 1] = wgKg(r._weightKdk) || '—'
      rowData[C_WT - 1] = wgKg((r._weightStorage || 0) + (r._weightKdk || 0)) || '—'

      const row = ws.addRow(rowData); row.height = 30
      row.eachCell({ includeEmpty: true }, (cell, cn) => {
        const hasNL = typeof cell.value === 'string' && cell.value.includes('\n')
        const isTotCol = [C_TOT, C_WORK, C_WS, C_WK, C_WT].includes(cn)
        let fill = isTotCol ? TOTAL_FILL : undefined
        if (cn >= C_H0 && cn <= C_HN) {
          const v = r.byHour?.[hours[cn - C_H0]] || 0
          if (v > 0) fill = (effectiveHeMode === 'hourly' ? zFill(r.byHourZone?.[hours[cn - C_H0]]) : szFill(v)) || undefined
        }
        cell.style = { border: BORDER, alignment: { ...ALIGN, wrapText: hasNL }, ...(fill ? { fill } : {}) }
      })
    }

    ws.getColumn(C_CO).width = 18; ws.getColumn(C_NAME).width = 30
    hours.forEach((_, i) => { ws.getColumn(C_H0 + i).width = 8 })
    ws.getColumn(C_TOT).width = 8; ws.getColumn(C_WORK).width = 10; ws.getColumn(C_SP).width = 13
    ws.getColumn(C_WS).width = 11; ws.getColumn(C_WK).width = 11; ws.getColumn(C_WT).width = 11

    const buf = await wb.xlsx.writeBuffer()
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `сотрудники_по_часам_${dateStr || 'дата'}.xlsx`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast.success('Файл .xlsx загружен')
  }

  const handleExportIdles = async () => {
    if (!mergedEmployeeRows.length) { toast.info('Нет данных для экспорта'); return }
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    wb.creator = 'ВС'; wb.created = new Date()
    const ws = wb.addWorksheet('Простои')

    const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
    const BORDER = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
    const ALIGN = { horizontal: 'center', vertical: 'middle' }

    const shiftLbl = shift === 'night' ? 'Ночная смена' : 'Дневная смена'
    const dateLbl = dateStr ? dateStr.split('-').reverse().join('.') : ''

    const NCOLS = 11
    ws.addRow([`Простои • ${dateLbl} • ${shiftLbl}`])
    ws.mergeCells(1, 1, 1, NCOLS)
    ws.getRow(1).getCell(1).style = { font: { bold: true, size: 13, color: { argb: 'FFFFFFFF' } }, fill: HEADER_FILL, alignment: { horizontal: 'left', vertical: 'middle' } }
    ws.getRow(1).height = 26

    const hdrRow = ws.addRow(['Компания', 'Сотрудник', 'Простои, мин', 'Интервалы', 'Отработано', 'Итого СЗ', 'Старт', 'Пик', 'Вес ХР, кг', 'Вес КДК, кг', 'Вес итог, кг'])
    hdrRow.height = 20
    hdrRow.eachCell(cell => { cell.style = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: HEADER_FILL, border: BORDER, alignment: ALIGN } })
    ws.views = [{ state: 'frozen', ySplit: 2 }]

    const fmtT = iso => iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—'
    const fmtMm = m => { const mm = Math.round(m || 0); return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}` }
    const wgKg = g => { const v = Number(g) || 0; return v > 0 ? +(v / 1000).toFixed(1) : '' }

    const shiftMinutes = getElapsedShiftMinutes(dateStr, shift)
    const sortedRows = [...mergedEmployeeRows].sort((a, b) => (b._idleTotalMinutes || 0) - (a._idleTotalMinutes || 0))
    for (const r of sortedRows) {
      const idleMin = r._idleTotalMinutes || 0
      const hasIdle = !!r._idleIntervals
      const workedMin = hasIdle ? computeWorkedMinutesInShift(idleMin, allowedIdleMinutes, shiftMinutes) : null

      const row = ws.addRow([
        r.company || '—', r.name, idleMin > 0 ? idleMin : '', r._idleIntervals || '',
        workedMin != null ? fmtMm(workedMin) : '—', r.total || 0, fmtT(r.firstAt), fmtT(r.lastAt),
        wgKg(r._weightStorage) || '', wgKg(r._weightKdk) || '', wgKg((r._weightStorage || 0) + (r._weightKdk || 0)) || '',
      ])
      row.height = 18
      row.eachCell({ includeEmpty: true }, (cell, cn) => { cell.style = { border: BORDER, alignment: { ...ALIGN, wrapText: cn === 4 } } })
      if (idleMin >= 60) row.getCell(3).style = { ...row.getCell(3).style, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFECACA' } } }
      else if (idleMin >= 30) row.getCell(3).style = { ...row.getCell(3).style, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF08A' } } }
    }

    ws.getColumn(1).width = 20; ws.getColumn(2).width = 32; ws.getColumn(3).width = 14
    ws.getColumn(4).width = 42; ws.getColumn(5).width = 12; ws.getColumn(6).width = 10
    ws.getColumn(7).width = 10; ws.getColumn(8).width = 10
    ws.getColumn(9).width = 12; ws.getColumn(10).width = 12; ws.getColumn(11).width = 12

    const buf = await wb.xlsx.writeBuffer()
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `простои_${dateStr || 'дата'}.xlsx`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast.success('Файл .xlsx загружен')
  }

  const handleExportClick = () => {
    if (effectiveHeMode === 'idles') return handleExportIdles()
    if (effectiveHeMode === 'monthly') return monthlyExportRef.current?.()
    return handleExportHourly()
  }

  if (loading && !summary) {
    return <div className="mx-auto w-full max-w-[1400px] p-6"><Spinner label="Загрузка статистики..." /></div>
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Статистика</h1>
          <p className="text-sm text-muted-foreground">Сводка по смене: выработка, вес, простои и состав по компаниям</p>
        </div>
      </div>

      {error && <div className="text-sm text-destructive">{error}</div>}

      {newEmployees.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="text-sm font-semibold text-warning-foreground">Новые сотрудники из WMS ({newEmployees.length}):</div>
            <div className="text-sm text-warning-foreground/90">{newEmployees.map(e => e.fio).join(', ')}</div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" onClick={handleAddNewEmployees}>Добавить в список</Button>
            <Button size="sm" variant="secondary" onClick={handleDismissNewEmployees}>Позже</Button>
          </div>
        </div>
      )}

      <StatsToolbar
        dateStr={dateStr} onDateChange={setDateStr}
        shift={shift} onShiftChange={setShift}
        operation={operation} onOperationChange={setOperation}
        fetchHourFrom={fetchHourFrom} fetchHourTo={fetchHourTo}
        onFetchHourFromChange={setFetchHourFrom} onFetchHourToChange={setFetchHourTo}
        lastUpdated={lastUpdated} engineNote={engineNote} autoFetchEnabled={autoFetchEnabled}
        onFetch={handleFetch} onRequestFetch={handleRequestFetch} onRecheck={handleRecheck} fetching={fetching}
        actions={actions}
      />

      {!isOperationStats && <StatsCards summary={summary} shiftLabel={shiftLabel} dateStr={dateStr} />}

      {!isOperationStats && <MissingWeightPanel />}

      <CompanyFilter companies={companies} value={filterCompany} onChange={setFilterCompany} />

      {!isOperationStats && (
        <StatsCard title="Сводка по компаниям">
          <CompanySummaryTable companySummary={summary?.companySummary} filterCompany={filterCompany} />
        </StatsCard>
      )}

      {!isOperationStats && (
        <StatsCard title="Сводка по компаниям за месяц">
          <MonthlyCompanySummaryTable />
        </StatsCard>
      )}

      <StatsCard title="Пики по часам">
        <HourlyChart hourly={chartHourly} />
      </StatsCard>

      <StatsCard
        title="Сотрудники по часам"
        headerExtra={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1 rounded-md border bg-muted/30 p-0.5">
              {HE_MODES.filter(m => !isOperationStats || m.key === 'sz' || m.key === 'monthly').map(m => (
                <Button key={m.key} size="sm" className="h-[26px] px-3 text-xs" variant={effectiveHeMode === m.key ? 'default' : 'ghost'} onClick={() => setHeTableMode(m.key)}>{m.label}</Button>
              ))}
            </div>
            {!isOperationStats && effectiveHeMode !== 'monthly' && (
              <>
                <div className="h-5 w-px bg-border" />
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  Порог, мин
                  <Input className="h-[26px] w-14 px-2 text-xs" type="number" min="0" readOnly={!canEditThresholds} value={idleThresholdMinutes} onChange={canEditThresholds ? e => setIdleThresholdMinutes(Number(e.target.value) || 0) : undefined} />
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  Доп. простоя, мин
                  <Input className="h-[26px] w-14 px-2 text-xs" type="number" min="0" readOnly={!canEditThresholds} value={allowedIdleMinutes} onChange={canEditThresholds ? e => setAllowedIdleMinutes(Number(e.target.value) || 0) : undefined} />
                </label>
              </>
            )}
            <div className="ml-auto h-5 w-px bg-border" />
            <Button size="sm" variant="secondary" className="h-[26px] px-3 text-xs" onClick={handleExportClick}>
              <Download className="size-3.5" /> XLSX
            </Button>
          </div>
        }
      >
        {effectiveHeMode === 'monthly' ? (
          <MonthlyEmployeeTable operation={operation} exportRef={monthlyExportRef} zoneCatalog={dayZoneCatalog} />
        ) : (
          <HourlyEmployeeTable
            mode={effectiveHeMode} hours={hours} rows={mergedEmployeeRows} isOperationStats={isOperationStats}
            operation={operation} shift={shift} dateStr={dateStr}
            allowedIdleMinutes={allowedIdleMinutes}
          />
        )}
      </StatsCard>
    </div>
  )
}
