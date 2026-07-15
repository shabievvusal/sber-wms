import { useEffect, useMemo, useState } from 'react'
import * as api from '@/lib/api'
import {
  getStoredToken, getReportMonitoringStats, getReportInboundCompleted, getReportInboundInProgress,
  getReportMovementsCount, getReportMovementsRest, getReportMoveToPickingCount, getReportMoveToPickingRest,
} from '@/lib/wmsFetch'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import {
  todayStr, fmt, fmtPct, loadManual, DEFAULT_PROC_NAMES, FIXED_PROC_NAMES,
  loadProcData, buildHourlyRows, calcRkStats, inboundWindow, shiftWindow, parseMonitoringStats,
} from './format'

// Перенесено «точь-в-точь» с оригинала (frontend/app/src/pages/reports/HourlyReport.jsx)
// по прямому запросу пользователя — та же 9-колоночная таблица-ведомость с
// жёлтыми шапками секций и узкой панелью ручного ввода справа, не
// переосмысленная под карточки. См. PLAN.md.

const td = 'border border-[#888] px-2 py-[3px] whitespace-nowrap align-middle'
const yh = `${td} bg-[#FFFF00] font-bold text-center`
const subh = `${td} bg-[#f2f2f2] font-semibold text-center text-[11px] leading-[1.4] align-bottom`
const sh2 = `${td} bg-[#f2f2f2] font-semibold text-center`
const lbl = `${td} bg-white font-medium`
const v = `${td} bg-white text-center`
const pn = `${td} bg-white text-xs`
const ec = `${td} bg-white` // "empty cell" — избегаем имени `e`, чтобы не путать с параметром события
const inv = 'border-none bg-background'

const EMPTY_PICKING = { kdk: { tasks: 0, done: 0, rest: 0 }, storage: { tasks: 0, done: 0, rest: 0 } }
const EMPTY_RECEPTION = { kdk: { received: 0, receiving: 0 }, storage: { received: 0, receiving: 0 } }
const EMPTY_REPL = { descents: { tasks: 0, done: 0, rest: 0 }, moves: { tasks: 0, done: 0, rest: 0 } }

export default function HourlyReport() {
  const [date, setDate] = useState(todayStr())
  const [upToHour, setUpToHour] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [hourlyRows, setHourlyRows] = useState([])
  const [rkStats, setRkStats] = useState({ perHourTC: 0, perHourRK: 0, deliveredRK: 0 })
  const [picking, setPicking] = useState(EMPTY_PICKING)
  const [reception, setReception] = useState(EMPTY_RECEPTION)
  const [repl, setRepl] = useState(EMPTY_REPL)

  const [procNames, setProcNames] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('hr_proc_names') ?? 'null')
      if (!saved) return DEFAULT_PROC_NAMES
      return [...DEFAULT_PROC_NAMES, ...saved.filter(n => !FIXED_PROC_NAMES.has(n))]
    } catch { return DEFAULT_PROC_NAMES }
  })
  const [procData, setProcData] = useState(() => loadProcData(todayStr()))
  const [newProcName, setNewProcName] = useState('')
  const [manual, setManual] = useState(() => loadManual(todayStr()))

  useEffect(() => { localStorage.setItem('hr_proc_names', JSON.stringify(procNames)) }, [procNames])
  useEffect(() => { localStorage.setItem(`hr_proc_${date}`, JSON.stringify(procData)) }, [procData, date])
  useEffect(() => { setProcData(loadProcData(date)) }, [date])
  useEffect(() => { localStorage.setItem(`hr_manual_${date}`, JSON.stringify(manual)) }, [manual, date])
  useEffect(() => { setManual(loadManual(date)) }, [date])

  const setM = (field, val) => setManual(prev => ({ ...prev, [field]: val }))
  const mi = field => ({
    type: 'number', min: '0',
    className: 'w-[60px] rounded-[3px] border border-gray-300 bg-[#fffde7] px-1 py-0.5 text-center text-xs',
    value: manual[field], onChange: e => setM(field, e.target.value), placeholder: '—',
  })
  const procs = procNames.map(name => ({ name, cnt: procData[name] ?? '' }))
  const setProcCnt = (name, val) => setProcData(prev => ({ ...prev, [name]: val }))
  const addProc = () => {
    const name = newProcName.trim()
    if (!name || procNames.includes(name)) return
    setProcNames(prev => [...prev, name])
    setNewProcName('')
  }
  const removeProc = name => { if (!FIXED_PROC_NAMES.has(name)) setProcNames(prev => prev.filter(n => n !== name)) }

  const load = async d => {
    setLoading(true)
    setError('')
    const token = getStoredToken()
    let pickingResult = EMPTY_PICKING
    if (!token) {
      setPicking(EMPTY_PICKING); setReception(EMPTY_RECEPTION); setRepl(EMPTY_REPL)
      setError('Нет активного WMS-токена — войдите паролем от WMS')
    } else {
      try {
        const { from: monFrom, to: monTo } = shiftWindow(d)
        const { from: rcpFrom, to: rcpTo } = inboundWindow(d)
        const [
          monData, kdkCompleted, storCompleted, kdkInProgress, storInProgress,
          movCount, movRest, movPickCount, movPickRest,
        ] = await Promise.all([
          getReportMonitoringStats(token, monFrom, monTo),
          getReportInboundCompleted(token, { types: 'CROSSDOCK', completedAtDateFrom: rcpFrom, completedAtDateTo: rcpTo }),
          getReportInboundCompleted(token, { types: ['STORAGE_DC', 'STORAGE', 'IMPORT'], completedAtDateFrom: rcpFrom, completedAtDateTo: rcpTo }),
          getReportInboundInProgress(token, { types: 'CROSSDOCK' }),
          getReportInboundInProgress(token, { types: ['STORAGE_DC', 'STORAGE', 'IMPORT'] }),
          getReportMovementsCount(token, { dateFrom: rcpFrom, dateTo: rcpTo }),
          getReportMovementsRest(token, { dateFrom: rcpFrom, dateTo: rcpTo }),
          getReportMoveToPickingCount(token, { dateFrom: rcpFrom, dateTo: rcpTo }),
          getReportMoveToPickingRest(token, { dateFrom: rcpFrom, dateTo: rcpTo }),
        ])
        const parsed = parseMonitoringStats(monData)
        if (parsed) pickingResult = parsed
        setPicking(pickingResult)
        setReception({
          kdk: { received: kdkCompleted?.value?.total ?? 0, receiving: kdkInProgress?.value?.total ?? 0 },
          storage: { received: storCompleted?.value?.total ?? 0, receiving: storInProgress?.value?.total ?? 0 },
        })
        const movTotal = movCount?.value?.total ?? 0
        const movRestN = movRest?.value?.total ?? 0
        const movPickTotal = movPickCount?.value?.total ?? 0
        const movPickRestN = movPickRest?.value?.total ?? 0
        setRepl({
          descents: { tasks: movTotal, done: movTotal - movRestN, rest: movRestN },
          moves: { tasks: movTotal, done: movPickTotal - movPickRestN, rest: movRestN + movPickRestN },
        })
      } catch (err) {
        setPicking(EMPTY_PICKING); setReception(EMPTY_RECEPTION); setRepl(EMPTY_REPL)
        setError(err.message || 'Не удалось загрузить данные WMS')
      }
    }

    try {
      const summary = await api.getDateSummaryFull(d)
      setHourlyRows(buildHourlyRows(summary, pickingResult, d))
    } catch (err) {
      setHourlyRows([])
      setError(err.message || 'Не удалось загрузить почасовую сводку')
    }
    try {
      const { from, to } = inboundWindow(d)
      const routes = await api.getRkRoutes({ receivedDateFrom: d, receivedDateTo: d, dateFrom: from, dateTo: to })
      setRkStats(calcRkStats(routes))
    } catch (err) {
      setRkStats({ perHourTC: 0, perHourRK: 0, deliveredRK: 0 })
      setError(err.message || 'Не удалось загрузить статистику РК')
    }
    setLoading(false)
  }

  useEffect(() => { load(date) }, [date])

  const kdkT = picking.kdk.tasks, kdkD = picking.kdk.done, kdkR = picking.kdk.rest
  const storT = picking.storage.tasks, storD = picking.storage.done, storR = picking.storage.rest
  const totT = kdkT + storT, totD = kdkD + storD, totR = kdkR + storR

  // «Ожидаем» всегда 0 — это мёртвое поле и в оригинале (ничего его не
  // заполняет, «План» тоже берётся из ручного ввода, а не отсюда).
  const rk = { received: reception.kdk.received, receiving: reception.kdk.receiving, waiting: 0 }
  const rs = { received: reception.storage.received, receiving: reception.storage.receiving, waiting: 0 }
  const rt = { received: rk.received + rs.received, receiving: rk.receiving + rs.receiving, waiting: rk.waiting + rs.waiting }

  const replData = repl

  const hourly = useMemo(
    () => hourlyRows.filter(row => row.done > 0 && (!upToHour || row.time <= upToHour)),
    [hourlyRows, upToHour]
  )
  const availableHours = useMemo(() => hourlyRows.filter(r => r.done > 0).map(r => r.time), [hourlyRows])

  const shiftKdkEmp = [...hourly].reverse().find(r => r.kdkEmp !== null)?.kdkEmp ?? null
  const shiftStorageEmp = [...hourly].reverse().find(r => r.storageEmp !== null)?.storageEmp ?? null
  const totalAllocated = (shiftKdkEmp ?? 0) + (shiftStorageEmp ?? 0)
    + procs.filter(p => !FIXED_PROC_NAMES.has(p.name)).reduce((s, p) => s + (Number(p.cnt) || 0), 0)
  const unallocated = manual.shiftTotal !== '' ? (Number(manual.shiftTotal) || 0) - totalAllocated : null

  return (
    <div className="pb-10">
      {/* Тулбар */}
      <div className="flex flex-wrap items-end gap-3 border-b bg-card p-3">
        <div className="flex flex-col gap-[3px]">
          <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Дата</label>
          <DatePicker value={date} onChange={e => setDate(e.target.value)} />
        </div>
        {availableHours.length > 0 && (
          <div className="flex flex-col gap-[3px]">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">До</label>
            <select
              value={upToHour} onChange={e => setUpToHour(e.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="">Все</option>
              {availableHours.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
          </div>
        )}
        {loading && <span className="pb-1 text-xs text-muted-foreground">Загрузка...</span>}
        {error && !loading && <span className="pb-1 text-xs text-destructive">{error}</span>}
        {!loading && (
          <Button size="sm" variant="secondary" onClick={() => load(date)}>Обновить</Button>
        )}
      </div>

      {/* Таблица + панель ввода — сама таблица (спредшит со слитыми ячейками)
          остаётся в горизонтальном скролле и на телефоне, карточной версии
          у неё нет (как и в оригинале у подобных плотных отчётов); упрощаем
          по минимуму — панель ручного ввода уходит под таблицу вместо сжатия
          сбоку. */}
      <div className="flex flex-col items-stretch gap-0 md:flex-row md:items-start">
        <div className="overflow-x-auto p-5">
          <table className="border-collapse font-sans text-[13px]">
            <colgroup>
              <col style={{ width: '140px' }} />
              <col style={{ width: '82px' }} />
              <col style={{ width: '82px' }} />
              <col style={{ width: '95px' }} />
              <col style={{ width: '115px' }} />
              <col style={{ width: '70px' }} />
              <col style={{ width: '148px' }} />
              <col style={{ width: '66px' }} />
              <col style={{ width: '66px' }} />
            </colgroup>
            <tbody>
              {/* ═══ ОТБОРКА ═══ */}
              <tr>
                <td className={ec} />
                <td className={yh}>КДК</td>
                <td className={yh}>Хранение</td>
                <td className={yh} colSpan={3}>Итог</td>
                <td className={inv} colSpan={3} rowSpan={5} />
              </tr>
              <tr>
                <td className={lbl}>Задачи</td>
                <td className={v}>{fmt(kdkT)}</td>
                <td className={v}>{fmt(storT)}</td>
                <td className={v} colSpan={3}>{fmt(totT)}</td>
              </tr>
              <tr>
                <td className={lbl}>Выполнено</td>
                <td className={v}>{fmt(kdkD)}</td>
                <td className={v}>{fmt(storD)}</td>
                <td className={v} colSpan={3}>{fmt(totD)}</td>
              </tr>
              <tr>
                <td className={lbl}>Остаток</td>
                <td className={v}>{fmt(kdkR)}</td>
                <td className={v}>{fmt(storR)}</td>
                <td className={v} colSpan={3}>{fmt(totR)}</td>
              </tr>
              <tr>
                <td className={lbl}>% отборки</td>
                <td className={v}>{fmtPct(kdkD, kdkT)}</td>
                <td className={v}>{fmtPct(storD, storT)}</td>
                <td className={v} colSpan={3}>{fmtPct(totD, totT)}</td>
              </tr>

              {/* ═══ Заголовок часовой таблицы ═══ */}
              <tr>
                <td className={ec} colSpan={3} />
                <td className={subh}>Кол-во<br />сотрудников<br />в час</td>
                <td className={subh}>Выполнено<br />са в час</td>
                <td className={subh}>Сред.<br />кол-во<br />СЗ</td>
                <td className={yh}>Процесс</td>
                <td className={yh} colSpan={2}>Кол-во сотр.</td>
              </tr>

              {/* ═══ Почасовые данные (переплетено со списком процессов по индексу, как в оригинале) ═══ */}
              {hourly.map((row, i) => {
                const proc = procs[i]
                const isKdk = proc?.name === 'Кросс-докинг'
                const isStorage = proc?.name === 'Хранение'
                const isFixed = isKdk || isStorage
                const autoVal = isKdk ? shiftKdkEmp : isStorage ? shiftStorageEmp : null
                return (
                  <tr key={row.time}>
                    <td className={lbl}>{row.time}</td>
                    <td className={v}>{fmt(row.kdk)}</td>
                    <td className={v}>{fmt(row.stor)}</td>
                    <td className={v}>{fmt(row.sotrud)}</td>
                    <td className={v}>{row.done !== null ? (row.done === 0 ? '0' : fmt(row.done)) : ''}</td>
                    <td className={v}>{row.avg !== null ? (row.avg === 0 ? '0' : fmt(row.avg)) : ''}</td>
                    {proc ? (
                      <>
                        <td className={pn}>
                          <span className="mr-1">{proc.name}</span>
                          {!isFixed && (
                            <button type="button" className="px-0.5 align-middle leading-none text-gray-400 hover:text-red-600" onClick={() => removeProc(proc.name)} title="Удалить">×</button>
                          )}
                        </td>
                        <td className={v} colSpan={2}>
                          {isFixed ? (
                            <span>{autoVal !== null ? fmt(autoVal) : '—'}</span>
                          ) : (
                            <input type="number" min="0" className="w-[60px] rounded-[3px] border border-gray-300 bg-[#fffde7] px-1 py-0.5 text-center text-xs" value={proc.cnt} onChange={ev => setProcCnt(proc.name, ev.target.value)} placeholder="—" />
                          )}
                        </td>
                      </>
                    ) : (
                      <td className={ec} colSpan={3} />
                    )}
                  </tr>
                )
              })}

              {/* Дополнительные процессы, которых больше чем почасовых строк */}
              {procs.slice(hourly.length).map(proc => {
                const isFixed = FIXED_PROC_NAMES.has(proc.name)
                const autoVal = proc.name === 'Кросс-докинг' ? shiftKdkEmp : proc.name === 'Хранение' ? shiftStorageEmp : null
                return (
                  <tr key={proc.name}>
                    <td className={ec} colSpan={6} />
                    <td className={pn}>
                      <span className="mr-1">{proc.name}</span>
                      {!isFixed && (
                        <button type="button" className="px-0.5 align-middle leading-none text-gray-400 hover:text-red-600" onClick={() => removeProc(proc.name)} title="Удалить">×</button>
                      )}
                    </td>
                    <td className={v} colSpan={2}>
                      {isFixed ? (
                        <span>{autoVal !== null ? fmt(autoVal) : '—'}</span>
                      ) : (
                        <input type="number" min="0" className="w-[60px] rounded-[3px] border border-gray-300 bg-[#fffde7] px-1 py-0.5 text-center text-xs" value={proc.cnt} onChange={ev => setProcCnt(proc.name, ev.target.value)} placeholder="—" />
                      )}
                    </td>
                  </tr>
                )
              })}

              {/* Итого по процессам */}
              <tr>
                <td className={ec} colSpan={6} />
                <td className={subh}>Итого</td>
                <td className={v} colSpan={2} style={{ fontWeight: 600 }}>{fmt(totalAllocated)}</td>
              </tr>

              {/* Добавить процесс */}
              <tr>
                <td className={ec} colSpan={6} />
                <td className={ec} colSpan={3}>
                  <div className="flex items-center gap-1 py-0.5">
                    <input
                      type="text" className="min-w-0 flex-1 rounded-[3px] border border-dashed border-gray-300 bg-gray-50 px-1.5 py-0.5 text-[11px]"
                      placeholder="Новый процесс..." value={newProcName}
                      onChange={ev => setNewProcName(ev.target.value)}
                      onKeyDown={ev => ev.key === 'Enter' && addProc()}
                    />
                    <button type="button" className="flex size-5 shrink-0 items-center justify-center rounded-[3px] border border-gray-300 bg-gray-100 text-sm hover:border-green-500 hover:bg-green-50 hover:text-green-800" onClick={addProc}>+</button>
                  </div>
                </td>
              </tr>

              {/* ═══ ПОПОЛНЕНИЕ ═══ */}
              <tr>
                <td className={yh} colSpan={6}>Пополнение</td>
                <td className={ec} colSpan={3} />
              </tr>
              <tr>
                <td className={ec} />
                <td className={sh2} colSpan={2}>Спуски</td>
                <td className={sh2} colSpan={3}>Перемещение</td>
                <td className={ec} colSpan={3} />
              </tr>
              {[
                ['Задачи', replData.descents.tasks, replData.moves.tasks],
                ['Выполнено', replData.descents.done, replData.moves.done],
                ['Остаток', replData.descents.rest, replData.moves.rest],
              ].map(([label, v1, v2]) => (
                <tr key={label}>
                  <td className={lbl}>{label}</td>
                  <td className={v} colSpan={2}>{fmt(v1)}</td>
                  <td className={v} colSpan={3}>{fmt(v2)}</td>
                  <td className={ec} colSpan={3} />
                </tr>
              ))}

              {/* ═══ ОТГРУЗКА ═══ */}
              <tr>
                <td className={yh} colSpan={6}>Отгрузка</td>
                <td className={ec} colSpan={3} />
              </tr>
              {[
                ['План', manual.shipPlan],
                ['Подготовлено ТС', manual.shipPrepared],
                ['Отгружено', manual.shipShipped],
                ['Отгружается', manual.shipInProgress],
                ['Задержка', manual.shipDelay],
              ].map(([label, val]) => (
                <tr key={label}>
                  <td className={lbl}>{label}</td>
                  <td className={v} colSpan={5}>{fmt(val)}</td>
                  <td className={ec} colSpan={3} />
                </tr>
              ))}

              {/* ═══ РОЛЛКЕЙДЖИ ═══ */}
              <tr>
                <td className={yh} colSpan={6}>Роллкейджи</td>
                <td className={ec} colSpan={3} />
              </tr>
              {[
                ['За час ТС', rkStats.perHourTC || null],
                ['За час РК', rkStats.perHourRK || null],
                ['Сдано РК', rkStats.deliveredRK || null],
                ['Общее кол-во РК', (rkStats.deliveredRK + (Number(manual.rkTotal) || 0)) || null],
              ].map(([label, val]) => (
                <tr key={label}>
                  <td className={lbl}>{label}</td>
                  <td className={v} colSpan={5}>{fmt(val)}</td>
                  <td className={ec} colSpan={3} />
                </tr>
              ))}

              {/* ═══ ПРИЁМКА ═══ */}
              <tr>
                <td className={yh} colSpan={9}>Приёмка</td>
              </tr>
              <tr>
                <td className={ec} />
                <td className={yh}>КДК</td>
                <td className={yh}>Хранение</td>
                <td className={yh} colSpan={6}>Итог</td>
              </tr>
              <tr>
                <td className={lbl}>План</td>
                <td className={v}>{fmt(manual.rcpKdkPlan)}</td>
                <td className={v}>{fmt(manual.rcpStorPlan)}</td>
                <td className={v} colSpan={6}>{fmt((Number(manual.rcpKdkPlan) || 0) + (Number(manual.rcpStorPlan) || 0)) || '—'}</td>
              </tr>
              {[
                ['Принято', rk.received, rs.received, rt.received],
                ['Принимается', rk.receiving, rs.receiving, rt.receiving],
                ['Ожидаем', rk.waiting, rs.waiting, rt.waiting],
              ].map(([label, v1, v2, vt]) => (
                <tr key={label}>
                  <td className={lbl}>{label}</td>
                  <td className={v}>{fmt(v1)}</td>
                  <td className={v}>{fmt(v2)}</td>
                  <td className={v} colSpan={6}>{fmt(vt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Панель ручного ввода */}
        <div className="flex w-full flex-col gap-5 border-t-2 border-[#e0e0e0] p-3 md:w-[220px] md:shrink-0 md:border-t-0 md:border-l-2">
          <div className="flex flex-col gap-1.5">
            <div className="mb-0.5 w-fit rounded-[3px] bg-[#ffeb3b] px-1.5 py-0.5 text-xs font-semibold text-black">Смена</div>
            <div className="flex items-center gap-1.5">
              <span className="flex-1 whitespace-nowrap text-xs text-gray-700">Всего</span>
              <input {...mi('shiftTotal')} className="w-[72px] rounded-[3px] border border-gray-300 bg-[#fffde7] px-1 py-0.5 text-right text-xs" />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="flex-1 whitespace-nowrap text-xs text-gray-700">Задействовано</span>
              <span className="inline-block w-[72px] px-1 py-0.5 text-right text-xs text-gray-800">{fmt(totalAllocated) || '—'}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="flex-1 whitespace-nowrap text-xs text-gray-700">Не задействовано</span>
              <span className="inline-block w-[72px] px-1 py-0.5 text-right text-xs text-gray-800" style={unallocated !== null && unallocated < 0 ? { color: '#d32f2f', fontWeight: 700 } : {}}>
                {unallocated !== null ? fmt(unallocated) || '0' : '—'}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="mb-0.5 w-fit rounded-[3px] bg-[#ffeb3b] px-1.5 py-0.5 text-xs font-semibold text-black">Отгрузка</div>
            {[
              ['План', 'shipPlan'], ['Подготовлено ТС', 'shipPrepared'], ['Отгружено', 'shipShipped'],
              ['Отгружается', 'shipInProgress'], ['Задержка', 'shipDelay'],
            ].map(([label, field]) => (
              <div key={field} className="flex items-center gap-1.5">
                <span className="flex-1 whitespace-nowrap text-xs text-gray-700">{label}</span>
                <input {...mi(field)} className="w-[72px] rounded-[3px] border border-gray-300 bg-[#fffde7] px-1 py-0.5 text-right text-xs" />
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="mb-0.5 w-fit rounded-[3px] bg-[#ffeb3b] px-1.5 py-0.5 text-xs font-semibold text-black">Роллкейджи</div>
            <div className="flex items-center gap-1.5">
              <span className="flex-1 whitespace-nowrap text-xs text-gray-700">Общее кол-во РК</span>
              <input {...mi('rkTotal')} className="w-[72px] rounded-[3px] border border-gray-300 bg-[#fffde7] px-1 py-0.5 text-right text-xs" />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="mb-0.5 w-fit rounded-[3px] bg-[#ffeb3b] px-1.5 py-0.5 text-xs font-semibold text-black">Приёмка — план</div>
            {[['КДК', 'rcpKdkPlan'], ['Хранение', 'rcpStorPlan']].map(([label, field]) => (
              <div key={field} className="flex items-center gap-1.5">
                <span className="flex-1 whitespace-nowrap text-xs text-gray-700">{label}</span>
                <input {...mi(field)} className="w-[72px] rounded-[3px] border border-gray-300 bg-[#fffde7] px-1 py-0.5 text-right text-xs" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
