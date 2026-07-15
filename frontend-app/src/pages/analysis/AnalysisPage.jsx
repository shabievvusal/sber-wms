import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import * as api from '@/lib/api'
import { getStoredToken, getReportMonitoringStats, getLiveMonitorViaBrowser, getInboundTasks, getInboundTaskDetail, getEoRemaining } from '@/lib/wmsFetch'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { ZoneCard, ProgressBar, StatRow } from './ZoneCard'
import {
  todayStr, fmt, fmtTime, buildSpeedMap, calcAvgSpeed, buildAnalysisHourlyRows, loadOverrides, saveOverrides,
  shiftWindow, mskFrom, mskTo, pieceQty, parseMonitoringStats, parseLivePeople, TEMP_TO_ZONE,
} from './format'
import { RefreshCw } from 'lucide-react'

// Перенесено практически без изменений из оригинала (frontend/app/src/pages/
// analysis/AnalysisPage.jsx) — это live-инструмент прогноза «успеваем ли до
// конца смены», а не многодневная статистика вопреки названию «Анализ». Есть
// настоящий WMS-токен → «Отборка»/живые люди/«Комплектация КДК» реальные
// (прямые браузерные вызовы); без токена — прежнее демо (см. PLAN.md).

export default function AnalysisPage() {
  const [date, setDate] = useState(todayStr)
  const [shiftEndTime, setShiftEndTime] = useState('21:00')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState(null)

  const [picking, setPicking] = useState(null)
  const [people, setPeople] = useState(null)
  const [hourlyRows, setHourlyRows] = useState(null)
  const [overrides, setOverrides] = useState(loadOverrides)

  const [speedsMap, setSpeedsMap] = useState(new Map())
  const [pickFcast, setPickFcast] = useState(null)
  const [loadingPickFcast, setLoadingPickFcast] = useState(true)

  const updateOverride = (key, val) => {
    const next = { ...overrides }
    if (val === '') delete next[key]
    else { const n = Number(val); if (!isNaN(n) && n > 0) next[key] = n; else delete next[key] }
    setOverrides(next)
    saveOverrides(next)
  }

  const shiftEnd = useMemo(() => {
    const [h, m] = shiftEndTime.split(':').map(Number)
    const d = new Date(); d.setHours(h, m, 0, 0)
    return d
  }, [shiftEndTime])

  const load = async d => {
    setLoading(true)
    setError('')
    const token = getStoredToken()
    if (token) {
      try {
        const { from, to } = shiftWindow(d)
        const [monData, liveData] = await Promise.all([
          getReportMonitoringStats(token, from, to),
          getLiveMonitorViaBrowser(token).catch(() => null),
        ])
        const parsed = parseMonitoringStats(monData)
        setPicking(parsed || null)
        setPeople(liveData ? parseLivePeople(liveData) : null)
      } catch (err) {
        setPicking(null)
        setPeople(null)
        setError(err.message || 'Не удалось загрузить данные WMS')
      }
    } else {
      setPicking(null)
      setPeople(null)
      setError('Нет активного WMS-токена — войдите паролем от WMS')
    }
    try {
      const summary = await api.getDateSummaryFull(d)
      setHourlyRows(buildAnalysisHourlyRows(summary))
    } catch (err) {
      setHourlyRows([])
      setError(err.message || 'Не удалось загрузить почасовую сводку')
    }
    setLastUpdated(new Date())
    setLoading(false)
  }

  useEffect(() => { load(date) }, [date])

  // Историческая скорость по артикулу (14 дней) — same-origin.
  useEffect(() => {
    const dateTo = date
    const d = new Date(date); d.setDate(d.getDate() - 14)
    const dateFrom = d.toISOString().slice(0, 10)
    api.getArticleSpeeds({ dateFrom, dateTo, opType: 'PICK_BY_LINE' })
      .then(res => setSpeedsMap(buildSpeedMap(res?.results)))
      .catch(() => setSpeedsMap(new Map()))
  }, [date])

  // Прогноз комплектации КДК — есть токен → реальные поставки WMS (кросс-докинг
  // за смену) + остаток по каждой ЕО; без токена — честная пустая сводка.
  useEffect(() => {
    let cancelled = false
    setLoadingPickFcast(true)
    const token = getStoredToken()
    if (!token) {
      setPickFcast({ supplyCount: 0, rows: [] })
      setLoadingPickFcast(false)
      return () => { cancelled = true }
    }
    async function run() {
      try {
        const res = await getInboundTasks(token, {
          types: ['CROSSDOCK'],
          statuses: ['COMPLETED_AS_PLANNED', 'COMPLETED_WITH_DISCREPANCY'],
          completedDateFrom: mskFrom(date), completedDateTo: mskTo(date),
          pageSize: 20,
        })
        const supplies = res?.value?.items ?? []
        if (!supplies.length || cancelled) { if (!cancelled) setPickFcast({ supplyCount: 0, rows: [] }); return }

        const details = await Promise.all(
          supplies.map(sup => getInboundTaskDetail(token, { taskType: 'CROSSDOCK', id: sup.id }))
        )
        if (cancelled) return

        const allProducts = []
        const barcodes = []; const seenBar = new Set()
        supplies.forEach((sup, i) => {
          const zone = TEMP_TO_ZONE[sup.temperatureMode] || 'KDS'
          const products = details[i]?.value?.products ?? details[i]?.products ?? []
          for (const prod of products) {
            allProducts.push({ ...prod, zone, supplyNum: sup.taskNumber })
            for (const part of (prod.parts ?? [])) {
              for (const hu of (part.handlingUnits ?? [])) {
                if (hu.handlingUnitBarcode && !seenBar.has(hu.handlingUnitBarcode)) {
                  seenBar.add(hu.handlingUnitBarcode)
                  barcodes.push(hu.handlingUnitBarcode)
                }
              }
            }
          }
        })

        const remainings = await Promise.all(barcodes.map(b => getEoRemaining(token, b)))
        if (cancelled) return
        const remMap = {}
        barcodes.forEach((b, i) => { remMap[b] = remainings[i] })

        const rows = allProducts.map(prod => {
          const totalQty = pieceQty(prod.actualQuantity) || pieceQty(prod.plannedQuantity)
          let remainingQty = 0
          for (const part of (prod.parts ?? [])) {
            for (const hu of (part.handlingUnits ?? [])) {
              const rem = remMap[hu.handlingUnitBarcode]
              remainingQty += (rem === null || rem === undefined) ? pieceQty(hu.actualQuantity) : rem
            }
          }
          return {
            id: prod.id, name: prod.name || '', code: prod.nomenclatureCode || '',
            zone: prod.zone, supplyNum: prod.supplyNum,
            totalQty, remainingQty: Math.max(0, remainingQty),
          }
        })

        if (!cancelled) setPickFcast({ supplyCount: supplies.length, rows })
      } catch { if (!cancelled) setPickFcast({ supplyCount: 0, rows: [] }) }
      finally { if (!cancelled) setLoadingPickFcast(false) }
    }
    run()
    return () => { cancelled = true }
  }, [date])

  const avgSpeed = calcAvgSpeed(hourlyRows)
  const ov = key => overrides[key] ?? null

  const pickByZone = useMemo(() => {
    if (!pickFcast) return {}
    const result = {}
    for (const z of ['KDS', 'KDH']) {
      const rows = pickFcast.rows.filter(r => r.zone === z)
      const remaining = rows.reduce((a, r) => a + r.remainingQty, 0)
      const totalQty = rows.reduce((a, r) => a + r.totalQty, 0)
      const speedRows = rows.map(r => {
        const record = speedsMap.get(`${r.code}:${r.zone}`)
        const speed = record?.qtyPerPersonHour || ov(`${z}_speed`) || null
        const ph = speed > 0 && r.remainingQty > 0 ? r.remainingQty / speed : null
        return { ...r, speed, personHours: ph }
      })
      const personHours = speedRows.reduce((a, r) => a + (r.personHours ?? 0), 0)
      result[z] = { remaining, totalQty, personHours, rows: speedRows }
    }
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickFcast, speedsMap, overrides])

  const storageRest = picking?.storage.rest ?? 0
  const shPeople = ov('SH_people') ?? 0
  const hhPeople = ov('HH_people') ?? 0
  const storTotal = shPeople + hhPeople
  const shRest = storTotal > 0 ? Math.round(storageRest * shPeople / storTotal) : (shPeople > 0 ? storageRest : null)
  const hhRest = storTotal > 0 ? storageRest - (shRest ?? 0) : (hhPeople > 0 ? storageRest : null)

  const totTasks = (picking?.kdk.tasks ?? 0) + (picking?.storage.tasks ?? 0)
  const totDone = (picking?.kdk.done ?? 0) + (picking?.storage.done ?? 0)
  const totRest = (picking?.kdk.rest ?? 0) + (picking?.storage.rest ?? 0)
  const totPct = totTasks > 0 ? Math.round(totDone / totTasks * 100) : 0

  const pickFcastRows = useMemo(() => {
    if (!pickFcast) return null
    return pickFcast.rows.map(r => {
      const record = speedsMap.get(`${r.code}:${r.zone}`)
      const speed = record?.qtyPerPersonHour || ov(`${r.zone}_speed`) || null
      const ph = speed > 0 && r.remainingQty > 0 ? r.remainingQty / speed : null
      return { ...r, speed, personHours: ph, fromFallback: !record && speed != null }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickFcast, speedsMap, overrides])

  const pickTotalRemaining = pickFcastRows?.reduce((a, r) => a + r.remainingQty, 0) ?? 0
  const pickTotalQty = pickFcastRows?.reduce((a, r) => a + r.totalQty, 0) ?? 0
  const pickPct = pickTotalQty > 0 ? Math.round((pickTotalQty - pickTotalRemaining) / pickTotalQty * 100) : 0

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-4 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Анализ смены</h1>
          <p className="text-sm text-muted-foreground">Прогноз завершения по зонам — успеваем ли до конца смены</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-sm">
            <span className="block text-xs text-muted-foreground">Дата</span>
            <DatePicker value={date} onChange={e => setDate(e.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="block text-xs text-muted-foreground">Конец смены</span>
            <input type="time" value={shiftEndTime} onChange={e => setShiftEndTime(e.target.value)} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm" />
          </label>
          <Button size="sm" variant="secondary" onClick={() => load(date)} disabled={loading}>
            <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} /> Обновить
          </Button>
          {lastUpdated && !loading && <span className="text-sm text-muted-foreground">Обновлено в {fmtTime(lastUpdated)}</span>}
          {avgSpeed != null && <span className="text-sm text-muted-foreground">Авто скорость: <b className="text-foreground">{avgSpeed} СЗ/чел/час</b></span>}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
        <ZoneCard
          zoneKey="KDS" label="Сухой КДК"
          rest={pickByZone.KDS?.remaining}
          restUnit="ед."
          personHours={pickByZone.KDS?.personHours || null}
          people={ov('KDS_people')}
          speed={ov('KDS_speed')}
          speedPlaceholder={avgSpeed}
          shiftEnd={shiftEnd} shiftEndTime={shiftEndTime} loading={loading || loadingPickFcast}
          onPeople={v => updateOverride('KDS_people', v)}
          onSpeed={v => updateOverride('KDS_speed', v)}
        />
        <ZoneCard
          zoneKey="KDH" label="Холодный КДК"
          rest={pickByZone.KDH?.remaining}
          restUnit="ед."
          personHours={pickByZone.KDH?.personHours || null}
          people={ov('KDH_people')}
          speed={ov('KDH_speed')}
          speedPlaceholder={avgSpeed}
          shiftEnd={shiftEnd} shiftEndTime={shiftEndTime} loading={loading || loadingPickFcast}
          onPeople={v => updateOverride('KDH_people', v)}
          onSpeed={v => updateOverride('KDH_speed', v)}
        />
        <ZoneCard
          zoneKey="SH" label="Сухое хранение"
          rest={shRest} restUnit="СЗ" personHours={null}
          people={ov('SH_people')} speed={ov('SH_speed')} speedPlaceholder={avgSpeed}
          shiftEnd={shiftEnd} shiftEndTime={shiftEndTime} loading={loading}
          onPeople={v => updateOverride('SH_people', v)}
          onSpeed={v => updateOverride('SH_speed', v)}
        />
        <ZoneCard
          zoneKey="HH" label="Холодное хранение"
          rest={hhRest} restUnit="СЗ" personHours={null}
          people={ov('HH_people')} speed={ov('HH_speed')} speedPlaceholder={avgSpeed}
          shiftEnd={shiftEnd} shiftEndTime={shiftEndTime} loading={loading}
          onPeople={v => updateOverride('HH_people', v)}
          onSpeed={v => updateOverride('HH_speed', v)}
        />

        <div className="space-y-2.5 rounded-lg border bg-card p-4">
          <div className="font-semibold">Итого</div>
          <ProgressBar done={totDone} total={totTasks} />
          <StatRow label="Всего задач" value={fmt(totTasks)} />
          <StatRow label="Выполнено" value={fmt(totDone)} />
          <StatRow label="Остаток" value={fmt(totRest)} bold />
          <StatRow label="Готово" value={totPct + '%'} />
        </div>
      </div>

      {(loadingPickFcast || pickFcast) && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            Комплектация КДК
            {pickFcast && (
              <span className="text-muted-foreground">
                · {pickFcast.supplyCount} {pickFcast.supplyCount === 1 ? 'поставка' : pickFcast.supplyCount < 5 ? 'поставки' : 'поставок'} · {pickPct}% скомплектовано
              </span>
            )}
          </div>

          {loadingPickFcast && !pickFcast ? (
            <Spinner label="Загрузка данных комплектации..." />
          ) : (
            <>
              {/* Мобильные карточки — до md (768px) */}
              <div className="divide-y rounded-md border md:hidden">
                {pickFcastRows
                  .filter(r => r.remainingQty > 0)
                  .sort((a, b) => (b.personHours ?? 0) - (a.personHours ?? 0))
                  .map(row => (
                    <div key={row.id} className="space-y-1.5 p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2">
                          <Badge variant="secondary">{row.zone}</Badge>
                          <span className="truncate font-medium">{row.name || '—'}</span>
                        </span>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">{row.code || '—'}</span>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                        <span>Принято: <span className="font-medium text-foreground">{fmt(row.totalQty)}</span></span>
                        <span>Осталось: <span className="font-semibold text-foreground">{fmt(Math.round(row.remainingQty))}</span></span>
                        <span>Скорость: <span className={cn('font-medium text-foreground', row.fromFallback && 'text-muted-foreground')}>{row.speed != null ? row.speed : '—'}</span></span>
                        <span>Часов работы: <span className="font-medium text-foreground">{row.personHours != null ? row.personHours.toFixed(2) : '—'}</span></span>
                      </div>
                    </div>
                  ))}
              </div>

              {/* Десктопная таблица — от md и шире */}
              <div className="hidden overflow-x-auto rounded-md border md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Зона</TableHead>
                      <TableHead>Артикул</TableHead>
                      <TableHead>Название</TableHead>
                      <TableHead className="text-right">Принято</TableHead>
                      <TableHead className="text-right">Осталось</TableHead>
                      <TableHead className="text-right">Скорость</TableHead>
                      <TableHead className="text-right">Часов работы</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pickFcastRows
                      .filter(r => r.remainingQty > 0)
                      .sort((a, b) => (b.personHours ?? 0) - (a.personHours ?? 0))
                      .map(row => (
                        <TableRow key={row.id}>
                          <TableCell><Badge variant="secondary">{row.zone}</Badge></TableCell>
                          <TableCell className="font-mono text-xs">{row.code || '—'}</TableCell>
                          <TableCell>{row.name || '—'}</TableCell>
                          <TableCell className="text-right">{fmt(row.totalQty)}</TableCell>
                          <TableCell className="text-right font-semibold">{fmt(Math.round(row.remainingQty))}</TableCell>
                          <TableCell className="text-right">
                            {row.speed != null ? <span className={row.fromFallback ? 'text-muted-foreground' : ''}>{row.speed}</span> : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell className="text-right">{row.personHours != null ? row.personHours.toFixed(2) : '—'}</TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>
      )}

      {hourlyRows && hourlyRows.length > 0 && (() => {
        const computedRows = hourlyRows.map((row, i) => {
          const prev = hourlyRows[i - 1]
          const trend = prev && prev.avg > 0 && row.avg > 0
            ? row.avg > prev.avg ? '↑' : row.avg < prev.avg ? '↓' : '→'
            : ''
          const trendCls = trend === '↑' ? 'text-success' : trend === '↓' ? 'text-destructive' : 'text-muted-foreground'
          const isAvgRow = row.avg > 0 && avgSpeed != null && row.avg >= avgSpeed
          return { row, trend, trendCls, isAvgRow }
        })
        return (
          <div className="space-y-2">
            <div className="text-sm font-medium">Почасовая динамика</div>

            {/* Мобильные карточки — до md (768px) */}
            <div className="divide-y rounded-md border md:hidden">
              {computedRows.map(({ row, trend, trendCls, isAvgRow }) => (
                <div key={row.time} className="flex items-center justify-between gap-3 p-3 text-sm">
                  <span className="font-medium">{row.time}</span>
                  <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-right text-muted-foreground">
                    <span>КДК {row.kdk != null ? fmt(row.kdk) : '—'}</span>
                    <span>Хран. {row.stor != null ? fmt(row.stor) : '—'}</span>
                    <span>Итого {row.done > 0 ? fmt(row.done) : '—'}</span>
                    <span>Людей {row.sotrud != null ? fmt(row.sotrud) : '—'}</span>
                    <span className={cn(isAvgRow && 'font-semibold text-success')}>СЗ/чел {row.avg > 0 ? row.avg : '—'}</span>
                    <span className={trendCls}>{trend || '—'}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Десктопная таблица — от md и шире */}
            <div className="hidden overflow-x-auto rounded-md border md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Час</TableHead>
                    <TableHead className="text-right">КДК</TableHead>
                    <TableHead className="text-right">Хранение</TableHead>
                    <TableHead className="text-right">Итого</TableHead>
                    <TableHead className="text-right">Людей</TableHead>
                    <TableHead className="text-right">Ср. СЗ/чел</TableHead>
                    <TableHead className="text-right">Тренд</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {computedRows.map(({ row, trend, trendCls, isAvgRow }) => (
                    <TableRow key={row.time}>
                      <TableCell className="font-medium">{row.time}</TableCell>
                      <TableCell className="text-right">{row.kdk != null ? fmt(row.kdk) : '—'}</TableCell>
                      <TableCell className="text-right">{row.stor != null ? fmt(row.stor) : '—'}</TableCell>
                      <TableCell className="text-right">{row.done > 0 ? fmt(row.done) : '—'}</TableCell>
                      <TableCell className="text-right">{row.sotrud != null ? fmt(row.sotrud) : '—'}</TableCell>
                      <TableCell className={`text-right ${isAvgRow ? 'font-semibold text-success' : ''}`}>{row.avg > 0 ? row.avg : '—'}</TableCell>
                      <TableCell className={`text-right ${trendCls}`}>{trend}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )
      })()}

      {!loading && !picking && (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">Нет данных за выбранную дату</div>
      )}
    </div>
  )
}
