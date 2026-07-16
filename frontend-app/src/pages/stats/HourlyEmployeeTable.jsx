import { useMemo, useState } from 'react'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { IdleTimeline } from './IdleTimeline'
import {
  buildZoneCatalog, computeWorkedMinutesInShift, fmtNum, fmtWeight, formatTime,
  getElapsedShiftMinutes, hourRangeLabel, isKdkZoneKey, shortFio, zoneColor, zoneLabel,
} from './format'

const thCls = 'h-8 border px-2 text-center text-[11px] whitespace-nowrap'
const tdCls = 'border px-2 py-1.5 text-center text-[13px] whitespace-nowrap'
const nameThCls = `${thCls} sticky left-0 z-[1] bg-card text-left`
const nameTdCls = `${tdCls} sticky left-0 z-[1] bg-card text-left font-medium`
const sortThCls = `${thCls} cursor-pointer select-none`

// Тепловая шкала «По СЗ» — дословно из оригинала: плоские цвета на границах,
// диагональный градиент в средней зоне (не проинтерполированный «промежуточный»
// цвет), явный тёмный текст (эти ячейки всегда светлые вне зависимости от темы).
function szCellStyle(v) {
  if (v < 50) return { backgroundColor: '#fecaca', color: '#1d1d1b' }
  if (v <= 75) return { background: 'linear-gradient(135deg,#fecaca 0%,#fef08a 100%)', color: '#1d1d1b' }
  return { backgroundColor: '#fff', color: '#1d1d1b' }
}

function zoneCellStyle(zoneKey) {
  if (!zoneKey) return {}
  const { light, text } = zoneColor(zoneKey)
  return { backgroundColor: light, color: text }
}

// Если по сотруднику нет прямого weightByEmployee (только у операции
// «Отбор» вообще есть вес), собираем вес из byZone/weightByHour+byHourZone —
// тот же фоллбек, что и в оригинале (getRowWeightFallback).
function resolveEmployeeWeight(row, weightDirect) {
  if (weightDirect && (weightDirect.storage || weightDirect.kdk || weightDirect.total)) return weightDirect
  const out = { storage: 0, kdk: 0, total: 0 }
  for (const [zoneKey, data] of Object.entries(row.byZone || {})) {
    const grams = Number(data?.weightGrams) || 0
    if (!grams) continue
    if (isKdkZoneKey(zoneKey)) out.kdk += grams; else out.storage += grams
    out.total += grams
  }
  if (out.total > 0) return out
  for (const [col, rawGrams] of Object.entries(row.weightByHour || {})) {
    const grams = Number(rawGrams) || 0
    if (!grams) continue
    const zoneKey = row.byHourZone?.[col]
    if (isKdkZoneKey(zoneKey)) out.kdk += grams
    else if (zoneKey) out.storage += grams
    out.total += grams
  }
  return out
}

function Legend({ mode, zoneCatalog }) {
  if (mode === 'sz') {
    return (
      <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 border-b pb-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3.5 w-[18px] rounded-sm" style={{ backgroundColor: '#fecaca' }} /> &lt;50 задач/ч</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3.5 w-[18px] rounded-sm" style={{ background: 'linear-gradient(135deg,#fecaca,#fef08a)' }} /> 50–75 задач/ч</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3.5 w-[18px] rounded-sm border" style={{ backgroundColor: '#fff' }} /> &gt;75 задач/ч</span>
      </div>
    )
  }
  if (mode === 'hourly') {
    // Легенда собрана из зон, реально встретившихся в текущих строках — не
    // из фиксированного списка (см. format.js: buildZoneCatalog).
    return (
      <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 border-b pb-2 text-xs text-muted-foreground">
        {zoneCatalog.map(z => (
          <span key={z.key} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span className="inline-block h-3.5 w-[18px] rounded-sm" style={{ backgroundColor: z.light }} /> {z.label}
          </span>
        ))}
      </div>
    )
  }
  return null
}

// Перенесено из оригинала (HourlyEmployeeTable.jsx) дословно — первый заход
// урезал структуру (объединённый заголовок «Старт/Пик» вместо настоящей
// двухстрочной ячейки, ни одна колонка кроме Компании/Исполнителя/Итого не
// сортировалась, не было легенды для режима «По СЗ», раскраска ячеек СЗ была
// интерполированным цветом вместо плоского/градиента оригинала) — исправлено
// 2026-07-12. «Матрица зон» (mode==='zones' в оригинале) убрана по прямому
// указанию пользователя («не нужна») — снова недостижима, как и в оригинале.
// Зоны («По зонам»: раскраска ячеек + легенда) больше не завязаны на
// фиксированный список — см. `buildZoneCatalog`/`zoneColor` в format.js
// (уточнение пользователя от 2026-07-12: «без хардкода»).
export function HourlyEmployeeTable({ mode, hours, rows, isOperationStats, operation, shift, dateStr, allowedIdleMinutes }) {
  const [sortCol, setSortCol] = useState('total')
  const [sortDir, setSortDir] = useState('desc')
  // Фильтр «час + зона» (запрос пользователя 2026-07-15): выбрал час и зону —
  // остаются только те, кто в этот час работал именно в этой зоне
  // (byHourZone[час] === зона). Работает поверх уже отфильтрованных по
  // компании rows (см. StatsPage.jsx: mergedEmployeeRows), поэтому фильтр по
  // компании учитывается сам по себе, без отдельной проводки.
  const [filterHour, setFilterHour] = useState('')
  const [filterZone, setFilterZone] = useState('')

  const shiftMinutes = useMemo(() => getElapsedShiftMinutes(dateStr, shift), [dateStr, shift])
  const isReceiving = operation === 'receiving'
  const showIdlesCol = mode === 'idles'
  const zoneCatalog = useMemo(() => buildZoneCatalog(rows), [rows])

  const enriched = useMemo(() => rows.map(r => {
    const idleMin = r._idleTotalMinutes || 0
    const hasIdle = !!r._idleIntervals
    const worked = hasIdle ? computeWorkedMinutesInShift(idleMin, allowedIdleMinutes, shiftMinutes) : null
    const weight = resolveEmployeeWeight(r, { storage: r._weightStorage || 0, kdk: r._weightKdk || 0, total: (r._weightStorage || 0) + (r._weightKdk || 0) })
    return { ...r, _worked: worked, _weight: weight }
  }), [rows, allowedIdleMinutes, shiftMinutes])

  const handleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortCol(col); setSortDir('desc') }
  }
  const sortArrow = col => sortCol === col ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ' ↕'

  const hourOnlyActive = !showIdlesCol && filterHour !== ''
  const hourZoneActive = hourOnlyActive && filterZone !== ''
  // Выбран час — показываем только его колонку (остальные 23 часа скрыты),
  // запрос пользователя 2026-07-15: «сделай отображение именно этого часа».
  // Не завязано на зону — зона доп. фильтрует СТРОКИ (ниже), а не колонки.
  const displayHours = hourOnlyActive ? [filterHour] : hours
  const visible = useMemo(
    () => hourZoneActive ? enriched.filter(r => r.byHourZone?.[filterHour] === filterZone) : enriched,
    [enriched, hourZoneActive, filterHour, filterZone]
  )

  const sorted = useMemo(() => [...visible].sort((a, b) => {
    if (sortCol === 'name') return (sortDir === 'asc' ? 1 : -1) * a.name.localeCompare(b.name, 'ru')
    if (sortCol === 'company') return (sortDir === 'asc' ? 1 : -1) * (a.company || '').localeCompare(b.company || '', 'ru')
    let av, bv
    // Сортировка по конкретному часу (запрос пользователя 2026-07-15) —
    // sortCol здесь число (сам час), а не одна из именованных строк ниже.
    if (typeof sortCol === 'number') { av = a.byHour?.[sortCol] || 0; bv = b.byHour?.[sortCol] || 0 }
    else if (sortCol === 'worked') { av = a._worked || 0; bv = b._worked || 0 }
    else if (sortCol === 'weightStorage') { av = a._weight.storage; bv = b._weight.storage }
    else if (sortCol === 'weightKdk') { av = a._weight.kdk; bv = b._weight.kdk }
    else if (sortCol === 'weight') { av = a._weight.total; bv = b._weight.total }
    else { av = a.total; bv = b.total }
    return sortDir === 'desc' ? bv - av : av - bv
  }), [visible, sortCol, sortDir])

  // Итоги над часовой сеткой (запрос пользователя 2026-07-15): по каждому
  // часу — сумма задач и среднее НА РАБОТАВШЕГО (делим на число сотрудников,
  // у которых в этот час было >0 задач, а не на всех видимых) — считается от
  // `visible` (то, что реально сейчас показано), значит уже учитывает и
  // фильтр по компании (снаружи), и фильтр «час+зона» здесь.
  const hourTotals = useMemo(() => {
    if (showIdlesCol) return {}
    const totals = {}
    for (const h of displayHours) {
      let sum = 0, workers = 0
      for (const r of visible) {
        const v = r.byHour?.[h] || 0
        if (v > 0) { sum += v; workers += 1 }
      }
      totals[h] = { sum, avg: workers > 0 ? sum / workers : 0 }
    }
    return totals
  }, [visible, displayHours, showIdlesCol])

  if (!rows.length) return <div className="p-6 text-center text-sm text-muted-foreground">Нет данных</div>

  return (
    <div className="space-y-2">
      <Legend mode={mode} zoneCatalog={zoneCatalog} />

      {!showIdlesCol && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs text-muted-foreground">Час / зона:</span>
          <select
            className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
            value={filterHour}
            onChange={e => setFilterHour(e.target.value === '' ? '' : Number(e.target.value))}
          >
            <option value="">Все часы</option>
            {hours.map(h => <option key={h} value={h}>{hourRangeLabel(h)}</option>)}
          </select>
          <select
            className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
            value={filterZone}
            onChange={e => setFilterZone(e.target.value)}
          >
            <option value="">Все зоны</option>
            {zoneCatalog.map(z => <option key={z.key} value={z.key}>{z.label}</option>)}
          </select>
          {hourOnlyActive && (
            <button type="button" className="text-xs font-medium text-primary" onClick={() => { setFilterHour(''); setFilterZone('') }}>
              Сбросить
            </button>
          )}
          {hourZoneActive && (
            <span className="text-xs text-muted-foreground">Найдено: {visible.length}</span>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={sortThCls} onClick={() => handleSort('company')}>Компания{sortArrow('company')}</TableHead>
              <TableHead className={`${nameThCls} cursor-pointer select-none`} onClick={() => handleSort('name')}>Сотрудник{sortArrow('name')}</TableHead>

              {!showIdlesCol && displayHours.map(h => (
                <TableHead key={h} className={`${sortThCls} min-w-[46px]`} title={hourRangeLabel(h)} onClick={() => handleSort(h)}>
                  {String(h).padStart(2, '0')}{sortArrow(h)}
                </TableHead>
              ))}
              {showIdlesCol && <TableHead className={`${thCls} min-w-[220px] text-left`} title="Паузы между задачами">Простои</TableHead>}

              <TableHead className={sortThCls} onClick={() => handleSort('total')}>Итого{sortArrow('total')}</TableHead>
              <TableHead className={sortThCls} title="Время в работе (смена − простои)" onClick={() => handleSort('worked')}>В работе{sortArrow('worked')}</TableHead>
              <TableHead className={thCls} title="Первая / последняя операция">
                Старт<div className="mt-px border-t border-current pt-px text-[10px] font-normal">Пик</div>
              </TableHead>
              <TableHead className={sortThCls} title="Вес в хранении" onClick={() => handleSort('weightStorage')}>Вес ХР{sortArrow('weightStorage')}</TableHead>
              <TableHead className={sortThCls} title="Вес в КДК" onClick={() => handleSort('weightKdk')}>Вес КДК{sortArrow('weightKdk')}</TableHead>
              <TableHead className={sortThCls} title="Вес итого" onClick={() => handleSort('weight')}>Вес итог{sortArrow('weight')}</TableHead>
            </TableRow>
            {!showIdlesCol && (
              <>
                <TableRow className="bg-muted/40">
                  <TableHead colSpan={2} className="sticky left-0 z-[1] bg-muted/40 text-left font-semibold">Итого:</TableHead>
                  {displayHours.map(h => (
                    <TableHead key={h} className={`${thCls} min-w-[46px] bg-muted/40 font-semibold`}>{hourTotals[h]?.sum > 0 ? fmtNum(hourTotals[h].sum) : '—'}</TableHead>
                  ))}
                  <TableHead colSpan={5} className="bg-muted/40" />
                </TableRow>
                <TableRow className="bg-muted/40">
                  <TableHead colSpan={2} className="sticky left-0 z-[1] bg-muted/40 text-left font-semibold" title="Среднее на работавшего сотрудника в этот час">Среднее:</TableHead>
                  {displayHours.map(h => (
                    <TableHead key={h} className={`${thCls} min-w-[46px] bg-muted/40 font-semibold`}>{hourTotals[h]?.avg > 0 ? hourTotals[h].avg.toFixed(1) : '—'}</TableHead>
                  ))}
                  <TableHead colSpan={5} className="bg-muted/40" />
                </TableRow>
              </>
            )}
          </TableHeader>
          <TableBody>
            {hourZoneActive && !sorted.length && (
              <TableRow>
                <TableCell colSpan={displayHours.length + 8} className="p-6 text-center text-muted-foreground">
                  Никто не работал в выбранной зоне в этот час
                </TableCell>
              </TableRow>
            )}
            {sorted.map(row => (
              <TableRow key={row.executorId || row.name}>
                <TableCell className={`${tdCls} text-muted-foreground`}>{row.company || '—'}</TableCell>
                <TableCell className={nameTdCls} title={row.name}>{shortFio(row.name)}</TableCell>

                {!showIdlesCol && displayHours.map(h => {
                  const v = row.byHour?.[h] || 0
                  const wg = row.weightByHour?.[h] || 0
                  const zoneKey = row.byHourZone?.[h]
                  const cellStyle = v > 0 ? (mode === 'hourly' ? zoneCellStyle(zoneKey) : szCellStyle(v)) : {}
                  // Подсказка по наведению (запрос пользователя 2026-07-15) — те же
                  // 4 факта, что и в оригинале: диапазон часа, кол-во операций (или
                  // поставок+ЕО для приёмки), зона, вес — через дефис, пустые пропускаются.
                  const cellTitle = v > 0 ? [
                    hourRangeLabel(h),
                    isReceiving ? `${fmtNum(v)} поставок` : `${fmtNum(v)} оп.`,
                    isReceiving ? `${fmtNum(row.secondaryByHour?.[h] || 0)} ЕО` : null,
                    zoneKey ? zoneLabel(zoneKey) : null,
                    wg > 0 ? fmtWeight(wg) : null,
                  ].filter(Boolean).join(' — ') : undefined
                  return (
                    <TableCell key={h} className={tdCls} style={cellStyle} title={cellTitle}>
                      {v > 0 && (
                        <>
                          <span className="font-semibold">{v}</span>
                          {isReceiving
                            ? <div className="mt-0.5 border-t border-current/20 pt-0.5 text-[10px] font-normal opacity-75">{fmtNum(row.secondaryByHour?.[h] || 0)} ЕО</div>
                            : wg > 0 && <div className="mt-0.5 border-t border-current/20 pt-0.5 text-[10px] font-normal opacity-75">{fmtWeight(wg)}</div>}
                        </>
                      )}
                    </TableCell>
                  )
                })}
                {showIdlesCol && (
                  <TableCell className={`${tdCls} text-left`}>
                    <IdleTimeline intervals={row._idleIntervals} shift={shift} workedMinutes={row._worked} />
                  </TableCell>
                )}

                <TableCell className={`${tdCls} font-bold`}>
                  {row.total}
                  {isReceiving && <div className="mt-px border-t border-current pt-px text-[10px] opacity-75">{fmtNum(row.secondaryTotal || 0)} ЕО</div>}
                </TableCell>
                <TableCell className={tdCls} title="Время в работе (смена − простои)">
                  {row._worked != null && row._worked > 0 ? `${Math.floor(row._worked / 60)}ч ${row._worked % 60}м` : '—'}
                </TableCell>
                <TableCell className={tdCls} title="Первая / последняя операция">
                  {row.firstAt ? formatTime(row.firstAt) : '—'}
                  <div className="mt-px border-t border-current pt-px text-[10px] opacity-75">{row.lastAt ? formatTime(row.lastAt) : '—'}</div>
                </TableCell>
                <TableCell className={tdCls} title="Вес в хранении">{row._weight.storage > 0 ? fmtWeight(row._weight.storage) : '—'}</TableCell>
                <TableCell className={tdCls} title="Вес в КДК">{row._weight.kdk > 0 ? fmtWeight(row._weight.kdk) : '—'}</TableCell>
                <TableCell className={tdCls} title="Вес итого">{row._weight.total > 0 ? fmtWeight(row._weight.total) : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
