import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import * as api from '../api/index.js'
import { normalizeFio, parseEmplCsv, flattenItem, personKey } from '../utils/emplUtils.js'
import { getTodayStr } from '../utils/format.js'
import { setProductWeights } from '../utils/statsCalc.js'
import { useNotify } from './NotifyContext.jsx'
import { useAuth } from './AuthContext.jsx'

let _autoFetchEnabled = false
try { _autoFetchEnabled = localStorage.getItem('vs_auto_fetch_enabled') === '1' } catch { /* ignore */ }

const DEFAULT_AUTO_FETCH_SETTINGS = {
  fullRefreshTimes: ['09:10', '21:10'],
  incrementalMinutes: 30,
  incrementalLookbackMinutes: 40,
}
const AUTO_FETCH_FULL_WINDOW_MINUTES = 5

function lsGetNum(key, def) {
  try { const v = localStorage.getItem(key); return v !== null && v !== '' ? Number(v) : def } catch { return def }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, String(val)) } catch { /* ignore */ }
}
function lsGet(key, def = '') {
  try { return localStorage.getItem(key) || def } catch { return def }
}

function normalizeAutoFetchSettings(settings) {
  return {
    ...DEFAULT_AUTO_FETCH_SETTINGS,
    ...(settings || {}),
    fullRefreshTimes: Array.isArray(settings?.fullRefreshTimes) && settings.fullRefreshTimes.length
      ? settings.fullRefreshTimes
      : DEFAULT_AUTO_FETCH_SETTINGS.fullRefreshTimes,
    incrementalMinutes: Number(settings?.incrementalMinutes) || DEFAULT_AUTO_FETCH_SETTINGS.incrementalMinutes,
    incrementalLookbackMinutes: Number(settings?.incrementalLookbackMinutes) || DEFAULT_AUTO_FETCH_SETTINGS.incrementalLookbackMinutes,
  }
}

function timeToMinutes(time) {
  const match = String(time || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hh = Number(match[1])
  const mm = Number(match[2])
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
  return hh * 60 + mm
}

function localDateStr(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function getDueFullRefreshTime(settings, now = new Date()) {
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  for (const time of settings.fullRefreshTimes || []) {
    const minutes = timeToMinutes(time)
    if (minutes == null) continue
    if (nowMinutes >= minutes && nowMinutes < minutes + AUTO_FETCH_FULL_WINDOW_MINUTES) return time
  }
  return null
}

function buildRollingRange(settings, now = new Date()) {
  const lookback = Math.max(5, Number(settings.incrementalLookbackMinutes) || DEFAULT_AUTO_FETCH_SETTINGS.incrementalLookbackMinutes)
  return {
    fromDate: new Date(now.getTime() - lookback * 60_000),
    toDate: now,
  }
}

const AppContext = createContext(null)

export function AppProvider({ children }) {
  const notify = useNotify()
  const { getToken, isTokenValid, forceRefresh } = useAuth()
  const [selectedDate, setSelectedDate] = useState(getTodayStr)
  const [shiftFilter, setShiftFilter] = useState('day')
  const [filterCompany, setFilterCompany] = useState('__all__')
  const [allItems, setAllItems] = useState([])
  const [dateSummary, setDateSummary] = useState(null)
  const [emplMap, setEmplMap] = useState(new Map())
  const [emplIdMap, setEmplIdMap] = useState(new Map())     // executorId → company
  const [emplIdNameMap, setEmplIdNameMap] = useState(new Map()) // executorId → fio
  const [emplNameMap, setEmplNameMap] = useState(new Map()) // personKey → full original fio from empl.csv
  const [emplCompanies, setEmplCompanies] = useState([])
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(false)
  const [heTableMode, setHeTableMode] = useState('sz')
  const [statsOperation, setStatsOperation] = useState('selection')
  const [idleThresholdMinutes, setIdleThresholdMinutesRaw] = useState(() => lsGetNum('vs_idle_threshold', 15))
  const [allowedIdleMinutes, setAllowedIdleMinutesRaw] = useState(() => lsGetNum('vs_allowed_idle', 0))

  const setIdleThresholdMinutes = useCallback(v => {
    setIdleThresholdMinutesRaw(v)
    if (v !== '' && !Number.isNaN(Number(v))) lsSet('vs_idle_threshold', v)
  }, [])
  const setAllowedIdleMinutes = useCallback(v => {
    setAllowedIdleMinutesRaw(v)
    if (v !== '' && !Number.isNaN(Number(v))) lsSet('vs_allowed_idle', v)
  }, [])
  const [fetchHourFrom, setFetchHourFrom] = useState(9)
  const [fetchHourTo, setFetchHourTo] = useState(21)
  const [engineNote, setEngineNote] = useState('')
  const [statsRefreshSeq, setStatsRefreshSeq] = useState(0)
  const [newEmployeesFromFetch, setNewEmployeesFromFetch] = useState([])
  const [autoFetchSettings, setAutoFetchSettings] = useState(DEFAULT_AUTO_FETCH_SETTINGS)
  const autoFetchEnabled = _autoFetchEnabled

  // refs so callbacks don't stale-close over state
  const selectedDateRef    = useRef(selectedDate)
  const shiftFilterRef     = useRef(shiftFilter)
  const fetchHourFromRef   = useRef(fetchHourFrom)
  const fetchHourToRef     = useRef(fetchHourTo)
  const autoFetchSettingsRef = useRef(autoFetchSettings)
  const lastKnownRunRef    = useRef(null)
  const autoFetchBusyRef   = useRef(false)
  const lastAutoIncrementalRunRef = useRef(Number(lsGet('vs_auto_fetch_last_incremental', '0')) || 0)
  const lastAutoFullRunKeyRef = useRef(lsGet('vs_auto_fetch_last_full_key', ''))
  useEffect(() => { selectedDateRef.current = selectedDate }, [selectedDate])
  useEffect(() => { shiftFilterRef.current  = shiftFilter  }, [shiftFilter])
  useEffect(() => { fetchHourFromRef.current = fetchHourFrom }, [fetchHourFrom])
  useEffect(() => { fetchHourToRef.current   = fetchHourTo   }, [fetchHourTo])
  useEffect(() => { autoFetchSettingsRef.current = autoFetchSettings }, [autoFetchSettings])

  const loadEmployees = useCallback(async () => {
    try {
      const data = await api.getEmployees()
      // Backend returns { employees: [{fio, company}], companies: [...] }
      if (data?.employees) {
        const map = new Map()
        const idMap = new Map()
        const idNameMap = new Map()
        const nameMap = new Map()
        const companySet = new Set()
        for (const { fio, company, executorId } of data.employees) {
          if (fio) {
            const norm = normalizeFio(fio)
            map.set(norm, company || '')
            const pk = personKey(norm)
            const existing = nameMap.get(pk)
            if (!existing || fio.split(/\s+/).length > existing.split(/\s+/).length) {
              nameMap.set(pk, fio)
            }
            if (company) companySet.add(company)
          }
          if (executorId) {
            idMap.set(executorId, company || '')
            if (fio) idNameMap.set(executorId, fio)
          }
        }
        setEmplMap(map)
        setEmplIdMap(idMap)
        setEmplIdNameMap(idNameMap)
        setEmplNameMap(nameMap)
        setEmplCompanies([...companySet].sort())
      } else {
        // fallback: CSV string
        const csv = typeof data === 'string' ? data : data.csv || data.data || ''
        const { map, companies } = parseEmplCsv(csv)
        setEmplMap(map)
        setEmplCompanies(companies)
      }
    } catch { /* ignore */ }
  }, [])

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.getStatus()
      setStatus(s)
      // Если lastRun изменился и смотрим сегодня — тихо обновляем сводку (как в оригинале)
      if (s?.lastRun && s.lastRun !== lastKnownRunRef.current) {
        lastKnownRunRef.current = s.lastRun
        if (selectedDateRef.current === getTodayStr()) {
          loadDateSummaryRef.current?.(selectedDateRef.current, shiftFilterRef.current)
        }
      }
    } catch { /* ignore */ }
  }, [])

  const loadAutoFetchSettings = useCallback(async () => {
    try {
      const settings = await api.getAutoFetchSettings()
      setAutoFetchSettings(normalizeAutoFetchSettings(settings))
    } catch { /* ignore */ }
  }, [])

  const loadDateSummaryRef = useRef(null)
  const loadDateSummary = useCallback(async (dateStr, shift) => {
    if (!dateStr) return
    setLoading(true)
    try {
      const res = await api.getDateSummary(dateStr, { shift, idleThresholdMinutes })
      setDateSummary(res)
      setAllItems([])
    } catch (err) {
      notify('Ошибка загрузки сводки: ' + err.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [idleThresholdMinutes, notify])
  useEffect(() => { loadDateSummaryRef.current = loadDateSummary }, [loadDateSummary])

  const loadDateData = useCallback(async (dateStr, shift) => {
    if (!dateStr) return
    setLoading(true)
    try {
      const res = await api.getDateItems(dateStr, { shift })
      const raw = res.items || []
      const items = raw.map(i => (i.executor !== undefined && i.completedAt !== undefined ? i : flattenItem(i)))
      setAllItems(items)
      setDateSummary(null)
    } catch (err) {
      console.error('Ошибка загрузки данных:', err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const runFetchDataRef = useRef(null)
  const runFetchData = useCallback(async (forceRecheck = false, silent = false, options = {}) => {
    const { rangeOverride = null } = options || {}
    const dateStr = selectedDateRef.current
    const shift   = shiftFilterRef.current
    const fromH   = fetchHourFromRef.current
    const toH     = fetchHourToRef.current
    if (!dateStr) return
    setLoading(true)
    setEngineNote('')
    try {
      let fromDate, toDate
      if (rangeOverride?.fromDate && rangeOverride?.toDate) {
        fromDate = rangeOverride.fromDate
        toDate = rangeOverride.toDate
      } else {
        const [y, m, d] = dateStr.split('-').map(Number)
        const clampH = h => Math.max(0, Math.min(23, h))
        if (shift === 'night' && clampH(fromH) >= clampH(toH)) {
          const next = new Date(y, m - 1, d)
          next.setDate(next.getDate() + 1)
          fromDate = new Date(y, m - 1, d, clampH(fromH), 0, 0, 0)
          toDate = new Date(next.getFullYear(), next.getMonth(), next.getDate(), Math.max(0, clampH(toH) - 1), 59, 59, 999)
        } else {
          fromDate = new Date(y, m - 1, d, clampH(fromH), 0, 0, 0)
          toDate   = new Date(y, m - 1, d, Math.max(clampH(fromH), clampH(toH) - 1), 59, 59, 999)
        }
      }
      const opts = {
        operationCompletedAtFrom: fromDate.toISOString(),
        operationCompletedAtTo:   toDate.toISOString(),
      }
      // Как в оригинальном app.js: если есть WMS-токен — грузим через браузер.
      // Независимые WMS-источники запускаем параллельно: комплектация и размещение.
      let res
      let placementRes = null
      let placementError = null
      let remainsRes = null
      let remainsError = null
      let token = getToken()
      if (token) {
        if (!isTokenValid()) {
          await forceRefresh()
          token = getToken()
        }
        if (!token) throw new Error('WMS токен истёк. Войдите в систему заново.')

        const fetchSelection = async (wmsToken, allowRefresh = true) => {
          try {
            return await api.fetchDataViaBrowser(wmsToken, opts)
          } catch (err) {
            if (allowRefresh && /401|403|unauthorized/i.test(err.message)) {
              const refreshed = await forceRefresh()
              if (!refreshed) throw new Error('Сессия истекла. Войдите в систему заново.')
              const freshToken = getToken()
              if (!freshToken) throw new Error('Не удалось получить токен после обновления.')
              token = freshToken
              return fetchSelection(freshToken, false)
            }
            throw err
          }
        }

        const fetchPlacement = async (wmsToken) => {
          try {
            return await api.fetchPlacementViaBrowser(wmsToken, {
              dateFrom: opts.operationCompletedAtFrom,
              dateTo: opts.operationCompletedAtTo,
            })
          } catch (err) {
            console.warn('placement fetch failed:', err)
            return { __error: err }
          }
        }

        const fetchRemains = async (wmsToken) => {
          try {
            return await api.fetchRemainsViaBrowser(wmsToken, {
              dateFrom: opts.operationCompletedAtFrom,
              dateTo: opts.operationCompletedAtTo,
            })
          } catch (err) {
            console.warn('remains fetch failed:', err)
            return { __error: err }
          }
        }

        const [selectionResult, placementResult, remainsResult] = await Promise.all([
          fetchSelection(token),
          fetchPlacement(token),
          fetchRemains(token),
        ])
        res = selectionResult
        if (placementResult?.__error) placementError = placementResult.__error
        else placementRes = placementResult
        if (remainsResult?.__error) remainsError = remainsResult.__error
        else remainsRes = remainsResult
      } else {
        res = await api.fetchData(opts)
      }
      if (res.success === false) throw new Error(res.error)
      if (!silent) {
        const placementText = placementRes
          ? ` · размещение: ${placementRes.fetched ?? '?'}/${placementRes.added ?? '?'}`
          : placementError
            ? ' · размещение не загружено'
            : ''
        const remainsText = remainsRes
          ? ` · остатки: ${remainsRes.fetched ?? '?'}/${remainsRes.added ?? '?'}`
          : remainsError
            ? ' · остатки не загружены'
            : ''
        notify(`Комплектация: получено ${res.fetched ?? '?'}, добавлено ${res.added ?? '?'}${placementText}${remainsText}`, placementError || remainsError ? 'info' : 'success')
      }
      // Build engine note
      const t = res.timings || {}
      const ms = v => Number.isFinite(v) ? `${Math.round(v / 100) / 10}с` : ''
      const parts = []
      if (res.engine === 'dotnet') parts.push('.NET')
      else if (res.engine === 'node') { parts.push('Node'); if (res.dotnetError) parts.push('.NET err') }
      if (t.totalMs)    parts.push(`итого ${ms(t.totalMs)}`)
      if (t.rawWriteMs) parts.push(`raw ${ms(t.rawWriteMs)}`)
      if (placementRes) parts.push(`размещение +${placementRes.added ?? 0}`)
      else if (placementError) parts.push('размещение: ошибка')
      if (remainsRes) parts.push(`остатки +${remainsRes.added ?? 0}`)
      else if (remainsError) parts.push('остатки: ошибка')
      setEngineNote(parts.join(' · '))
      const mergedNewEmployees = []
      const seenNewEmployees = new Set()
      for (const emp of [...(res.newEmployees || []), ...(placementRes?.newEmployees || []), ...(remainsRes?.newEmployees || [])]) {
        const key = typeof emp === 'string' ? emp : (emp.executorId || emp.fio || '')
        if (!key || seenNewEmployees.has(key)) continue
        seenNewEmployees.add(key)
        mergedNewEmployees.push(emp)
      }
      if (mergedNewEmployees.length > 0) setNewEmployeesFromFetch(mergedNewEmployees)
      await loadEmployees()
      await loadDateSummary(dateStr, shift)
      await loadStatus()
      setStatsRefreshSeq(v => v + 1)
    } catch (err) {
      notify('Ошибка: ' + err.message, 'error')
      throw err
    } finally {
      setLoading(false)
    }
  }, [loadDateSummary, loadStatus, loadEmployees])
  useEffect(() => { runFetchDataRef.current = runFetchData }, [runFetchData])

  const doAutoFetch = useCallback(async ({ forceIncremental = false } = {}) => {
    if (selectedDateRef.current !== getTodayStr()) return
    if (autoFetchBusyRef.current) return
    const settings = normalizeAutoFetchSettings(autoFetchSettingsRef.current)
    const now = new Date()
    const dueFullTime = getDueFullRefreshTime(settings, now)
    const fullRunKey = dueFullTime ? `${localDateStr(now)}_${dueFullTime}` : ''
    const shouldRunFull = Boolean(dueFullTime && fullRunKey !== lastAutoFullRunKeyRef.current)
    const incrementalMs = Math.max(5, Number(settings.incrementalMinutes) || DEFAULT_AUTO_FETCH_SETTINGS.incrementalMinutes) * 60_000
    const shouldRunIncremental = forceIncremental || (Date.now() - lastAutoIncrementalRunRef.current >= incrementalMs)
    if (!shouldRunFull && !shouldRunIncremental) return

    const refreshed = await forceRefresh()
    if (!refreshed) return
    const token = getToken()
    if (!token) return
    autoFetchBusyRef.current = true
    try {
      const rangeOverride = shouldRunFull ? null : buildRollingRange(settings, now)
      await runFetchDataRef.current?.(false, true, { rangeOverride })
      if (shouldRunFull) {
        lastAutoFullRunKeyRef.current = fullRunKey
        lsSet('vs_auto_fetch_last_full_key', fullRunKey)
        lastAutoIncrementalRunRef.current = Date.now()
        lsSet('vs_auto_fetch_last_incremental', lastAutoIncrementalRunRef.current)
      } else {
        lastAutoIncrementalRunRef.current = Date.now()
        lsSet('vs_auto_fetch_last_incremental', lastAutoIncrementalRunRef.current)
      }
      await api.markUpdated()
      await loadStatus()
    } catch { /* ignore */ } finally {
      autoFetchBusyRef.current = false
    }
  }, [forceRefresh, getToken, loadStatus])

  // Обрабатываем очередь обновления ЕО (только на корп. устройстве с автофетчем)
  const doAutoEoRefresh = useCallback(async (queue) => {
    if (!queue || !queue.length) return
    const refreshed = await forceRefresh()
    if (!refreshed) return
    const token = getToken()
    if (!token) return
    for (const routeId of queue) {
      try {
        const wmsData = await api.fetchRouteFromWMS(token, routeId)
        await fetch(`/api/rk/routes/${encodeURIComponent(routeId)}/eos/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(wmsData),
        })
      } catch { /* ignore */ }
    }
  }, [forceRefresh, getToken])

  const doRequestFetch = useCallback(async () => {
    try {
      await api.requestFetch()
      notify('Запрос на обновление отправлен', 'info')
    } catch (err) {
      notify('Ошибка: ' + err.message, 'error')
    }
  }, [notify])

  const dismissNewEmployees = useCallback(() => setNewEmployeesFromFetch([]), [])

  const loadProductWeights = useCallback(async () => {
    try {
      const weights = await api.getProductWeights()
      setProductWeights(weights)
      return weights
    } catch {
      setProductWeights({})
      return {}
    }
  }, [])

  const addNewEmployees = useCallback(async (names) => {
    try {
      const data = await api.addNewEmployees(names)
      if (!data?.ok) throw new Error(data?.error || 'Ошибка добавления')
      setNewEmployeesFromFetch([])
      await loadEmployees()
      notify(`Добавлено сотрудников: ${data.added}`, 'success')
    } catch (err) {
      notify('Ошибка: ' + err.message, 'error')
    }
  }, [loadEmployees, notify])

  useEffect(() => {
    loadProductWeights()
    loadEmployees()
    loadAutoFetchSettings()
    loadStatus()
  }, [loadProductWeights, loadEmployees, loadAutoFetchSettings, loadStatus])

  useEffect(() => {
    const t = setInterval(() => loadAutoFetchSettings(), 60_000)
    return () => clearInterval(t)
  }, [loadAutoFetchSettings])

  useEffect(() => {
    loadDateSummary(selectedDate, shiftFilter)
  }, [selectedDate, shiftFilter])

  // Перезагрузка сводки при смене порога простоя (с дебаунсом)
  useEffect(() => {
    const t = setTimeout(() => {
      loadDateSummaryRef.current?.(selectedDateRef.current, shiftFilterRef.current)
    }, 400)
    return () => clearTimeout(t)
  }, [idleThresholdMinutes])

  // Автоподстановка часов при смене shift
  useEffect(() => {
    if (shiftFilter === 'night') {
      setFetchHourFrom(21)
      setFetchHourTo(9)
    } else {
      setFetchHourFrom(9)
      setFetchHourTo(21)
    }
  }, [shiftFilter])

  // Статус каждые 10 сек + реакция на fetchRequested и eoRefreshQueue
  useEffect(() => {
    const t = setInterval(async () => {
      await loadStatus()
      setStatus(prev => {
        if (autoFetchEnabled) {
          // fetchRequested → немедленный фетч статистики
          if (prev?.fetchRequested && !autoFetchBusyRef.current) {
            doAutoFetch({ forceIncremental: true })
          }
          // eoRefreshQueue → обновляем ЕО по очереди
          if (prev?.eoRefreshQueue?.length) {
            doAutoEoRefresh(prev.eoRefreshQueue)
          }
        }
        return prev
      })
    }, 10_000)
    return () => clearInterval(t)
  }, [loadStatus, doAutoFetch, doAutoEoRefresh, autoFetchEnabled])

  // Проверяем расписание раз в минуту, WMS дергаем только по условиям doAutoFetch.
  useEffect(() => {
    if (!autoFetchEnabled) return
    const t = setInterval(() => doAutoFetch(), 60_000)
    return () => clearInterval(t)
  }, [autoFetchEnabled, doAutoFetch])

  // Авто-обновление сводки каждые 10 минут (если смотрим сегодня)
  useEffect(() => {
    const t = setInterval(() => {
      if (selectedDateRef.current === getTodayStr()) {
        loadDateSummaryRef.current?.(selectedDateRef.current, shiftFilterRef.current)
      }
    }, 10 * 60_000)
    return () => clearInterval(t)
  }, [])

  return (
    <AppContext.Provider value={{
      selectedDate, setSelectedDate,
      shiftFilter, setShiftFilter,
      filterCompany, setFilterCompany,
      allItems, setAllItems,
      dateSummary, setDateSummary,
      emplMap, emplIdMap, emplIdNameMap, emplNameMap, emplCompanies,
      status, loading,
    heTableMode, setHeTableMode,
    statsOperation, setStatsOperation,
    statsRefreshSeq,
      idleThresholdMinutes, setIdleThresholdMinutes,
      allowedIdleMinutes, setAllowedIdleMinutes,
      fetchHourFrom, setFetchHourFrom,
      fetchHourTo, setFetchHourTo,
      engineNote,
      autoFetchEnabled,
      autoFetchSettings,
      loadDateSummary,
      loadDateData,
      loadAutoFetchSettings,
      loadProductWeights,
      runFetchData,
      doRequestFetch,
      loadEmployees,
      newEmployeesFromFetch,
      dismissNewEmployees,
      addNewEmployees,
    }}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  return useContext(AppContext)
}
