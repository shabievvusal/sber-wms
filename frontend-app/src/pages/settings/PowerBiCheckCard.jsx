// Настройки → Система → «Сверка комплектации с PowerBI». Одна смена из WMS,
// посчитанная разными способами (powerbiCheck.js): сравните с PowerBI по
// нескольким сотрудникам — колонка, где цифры совпали у всех, и есть правило
// PowerBI. Только просмотр, в базу ничего не пишется.
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { getStoredToken } from '@/lib/wmsFetch'
import { fetchAllStockChanges } from '@/lib/wms/stockChanges'
import { runExport } from '@/lib/exportProgress'
import { NUM, addTable, titleRows } from '@/pages/stats/receivingExport'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SettingCard } from './SettingCard'
import { PICK_TYPES, buildVariants, computeCheck, discoverIdFields, normalize, shiftWindow } from './powerbiCheck'
import { Download, Scale, Search } from 'lucide-react'
import { cn } from '@/lib/utils'

const HOUR = 3_600_000
const yesterday = () => new Date(Date.now() + 3 * HOUR - 24 * HOUR).toISOString().slice(0, 10)
const fmtTime = ms => new Date(ms + 3 * HOUR).toISOString().slice(11, 16)
const fmtDay = d => d.split('-').reverse().join('.')

const BOUNDS = {
  day: [{ v: -1, label: '08:00–20:00' }, { v: 0, label: '09:00–21:00 (как у нас)' }, { v: 1, label: '10:00–22:00' }],
  night: [{ v: -1, label: '20:00–08:00' }, { v: 0, label: '21:00–09:00 (как у нас)' }, { v: 1, label: '22:00–10:00' }],
}

export function PowerBiCheckCard() {
  const [date, setDate] = useState(yesterday())
  const [shift, setShift] = useState('day')
  const [loaded, setLoaded] = useState(null) // { date, shift, lines, idFields, sample, site }
  const [onlyDiff, setOnlyDiff] = useState(false)
  const [loading, setLoading] = useState(null) // { page, pages, rows }
  const [type, setType] = useState('all')
  const [shiftHours, setShiftHours] = useState(0)
  const [query, setQuery] = useState('')
  const [companyById, setCompanyById] = useState(new Map())

  useEffect(() => {
    api.getEmployees()
      .then(d => setCompanyById(new Map((d.employees || []).filter(e => e.executorId).map(e => [e.executorId, e.company || '—']))))
      .catch(() => {})
  }, [])

  const load = async () => {
    const token = getStoredToken()
    if (!token) { toast.error('Нет активного WMS-токена — войдите паролем от WMS'); return }
    // с запасом в час с обеих сторон — чтобы сравнить и другие границы смены
    const w = shiftWindow(date, shift)
    setLoading({ page: 0, pages: 0, rows: 0 })
    try {
      const raw = await fetchAllStockChanges(token, {
        operationTypes: PICK_TYPES,
        from: new Date(w.from - HOUR).toISOString(),
        to: new Date(w.to + HOUR - 1).toISOString(),
      }, setLoading)
      // цифры сайта (наша база) за ту же смену — тот же отчёт, что в статистике
      const report = await api.getOpReport('selection', date, date, shift).catch(() => null)
      const site = new Map((report?.executors || []).map(e => [e.key, e]))
      setLoaded({ date, shift, lines: raw.map(normalize), idFields: discoverIdFields(raw), sample: raw[0] || null, site })
      setShiftHours(0)
    } catch (err) {
      toast.error('Не удалось загрузить из WMS: ' + (err.message || err))
    } finally {
      setLoading(null)
    }
  }

  const variants = useMemo(() => buildVariants(loaded?.idFields || []), [loaded])
  const result = useMemo(() => (loaded
    ? computeCheck(loaded.lines, { date: loaded.date, shift: loaded.shift, shiftHours, type, variants, companyById })
    : null), [loaded, shiftHours, type, variants, companyById])

  // сайт: СЗ по выбранному типу; штуки — только «хранение + КДК» (по типам отчёт их не делит)
  const siteOf = r => {
    const e = loaded?.site?.get(r.execId)
    if (!e) return { sz: 0, qty: type === 'all' ? 0 : null }
    return { sz: type === 'all' ? e.tasks : type === 'kdk' ? e.kdkTasks : e.storageTasks, qty: type === 'all' ? Number(e.qty) || 0 : null }
  }
  // с чем сравниваем сайт: строка детализации PowerBI и «положено»
  const isDiff = r => {
    const s = siteOf(r)
    return s.sz !== r.values.srcTgtProduct || (s.qty != null && s.qty !== r.values.qtyDelta)
  }
  const shown = useMemo(() => {
    if (!result) return []
    const q = query.trim().toLowerCase()
    let list = q ? result.rows.filter(r => r.fio.toLowerCase().includes(q) || r.company.toLowerCase().includes(q)) : result.rows
    if (onlyDiff) list = list.filter(isDiff)
    return list
  }, [result, query, onlyDiff, type, loaded]) // eslint-disable-line react-hooks/exhaustive-deps
  const siteTotal = useMemo(() => (result
    ? result.rows.reduce((t, r) => { const s = siteOf(r); return { sz: t.sz + s.sz, qty: s.qty == null ? null : (t.qty ?? 0) + s.qty } }, { sz: 0, qty: type === 'all' ? 0 : null })
    : null), [result, type, loaded]) // eslint-disable-line react-hooks/exhaustive-deps
  const diffCount = result ? result.rows.filter(isDiff).length : 0

  const typeLabel = { all: 'хранение + КДК', storage: 'хранение', kdk: 'КДК' }[type]
  const periodLabel = result
    ? `${fmtDay(loaded.date)} · ${loaded.shift === 'night' ? 'ночь' : 'день'} ${fmtTime(result.from)}–${fmtTime(result.to)} МСК · ${typeLabel}`
    : ''

  const exportXlsx = () => runExport(`сверка_PowerBI_${loaded.date}_${loaded.shift}_${type}.xlsx`, async p => {
    const ExcelJS = await p.excel()
    const wb = new ExcelJS.Workbook()
    wb.creator = 'ВС'
    const ws = wb.addWorksheet('Сверка')
    const cols = [
      { header: 'Сотрудник', key: 'fio', width: 34 },
      { header: 'Компания', key: 'company', width: 18 },
      ...variants.map(v => ({ header: `${v.group}: ${v.label}`, key: v.key, numFmt: NUM, width: 14 })),
      { header: 'Сайт: СЗ', key: 'siteSz', numFmt: NUM, width: 12 },
      ...(type === 'all' ? [{ header: 'Сайт: штук', key: 'siteQty', numFmt: NUM, width: 12 }] : []),
    ]
    titleRows(ws, 'Комплектация — способы подсчёта', `${periodLabel} · строк в смене ${result.lines}`, cols.length)
    addTable(ws, cols, result.rows.map(r => ({ fio: r.fio, company: r.company, ...r.values, siteSz: siteOf(r).sz, siteQty: siteOf(r).qty })), {
      freezeCols: 1,
      total: { fio: 'Итого', ...result.total, siteSz: siteTotal.sz, siteQty: siteTotal.qty },
    })
    await p.save(wb, `сверка_PowerBI_${loaded.date}_${loaded.shift}_${type}.xlsx`)
  })

  return (
    <SettingCard
      icon={Scale}
      title="Сверка комплектации с PowerBI"
      subtitle="Одна смена из WMS, посчитанная разными способами, и цифры нашего сайта. Красным — где сайт расходится со строкой PowerBI («ЕО-источник + ЕО-получатель + товар») или штуками «положено»."
      actions={result && (
        <Button size="sm" variant="secondary" onClick={() => exportXlsx().catch(err => toast.error(err.message))}>
          <Download className="size-3.5" /> Excel
        </Button>
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <DatePicker className="h-8 w-40" value={date} onChange={e => setDate(e.target.value)} />
        <Select className="h-8 w-32" value={shift} onChange={e => setShift(e.target.value)}>
          <option value="day">День</option>
          <option value="night">Ночь</option>
        </Select>
        <Button size="sm" onClick={load} disabled={!!loading || !date}>
          {loading ? 'Загрузка…' : 'Загрузить из WMS'}
        </Button>
        {loading && (
          <span className="text-xs text-muted-foreground">
            {loading.pages ? `страница ${loading.page} из ${loading.pages} · строк ${loading.rows.toLocaleString('ru-RU')}` : 'запрос к WMS…'}
          </span>
        )}
      </div>

      {result && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select className="h-8 w-44" value={type} onChange={e => setType(e.target.value)}>
              <option value="all">Хранение + КДК</option>
              <option value="storage">Только хранение</option>
              <option value="kdk">Только КДК</option>
            </Select>
            <Select className="h-8 w-56" value={String(shiftHours)} onChange={e => setShiftHours(Number(e.target.value))}>
              {BOUNDS[loaded.shift].map(b => <option key={b.v} value={String(b.v)}>{b.label}</option>)}
            </Select>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input className="h-8 w-56 pl-8" placeholder="Сотрудник или компания" value={query} onChange={e => setQuery(e.target.value)} />
            </div>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} />
              Только расхождения с сайтом ({diffCount})
            </label>
            <span className="text-xs text-muted-foreground">{periodLabel} · строк в смене {result.lines.toLocaleString('ru-RU')}</span>
          </div>

          <div className="max-h-[560px] overflow-auto rounded-2xl border border-line">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-20 bg-card">Сотрудник</TableHead>
                  <TableHead>Компания</TableHead>
                  {variants.map(v => (
                    <TableHead key={v.key} className="text-center normal-case" title={v.hint}>
                      <div className="text-[10px] uppercase tracking-wide">{v.group}</div>
                      <div className="whitespace-normal text-xs font-semibold text-foreground">{v.label}</div>
                    </TableHead>
                  ))}
                  <TableHead className="text-center normal-case" title="СЗ сотрудника в нашей статистике (база сайта), смена 09–21 / 21–09">
                    <div className="text-[10px] uppercase tracking-wide">Сайт</div>
                    <div className="text-xs font-semibold text-foreground">СЗ</div>
                  </TableHead>
                  {type === 'all' && (
                    <TableHead className="text-center normal-case" title="Штуки сотрудника в нашей статистике (база сайта)">
                      <div className="text-[10px] uppercase tracking-wide">Сайт</div>
                      <div className="text-xs font-semibold text-foreground">Штук</div>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow className="bg-surface-2/60 font-semibold">
                  <TableCell className="sticky left-0 bg-card">Итого</TableCell>
                  <TableCell>{result.rows.length} чел.</TableCell>
                  {variants.map(v => <TableCell key={v.key} className="text-center">{result.total[v.key].toLocaleString('ru-RU')}</TableCell>)}
                  <TableCell className={cn('text-center', siteTotal.sz !== result.total.srcTgtProduct && 'text-destructive')}>{siteTotal.sz.toLocaleString('ru-RU')}</TableCell>
                  {type === 'all' && <TableCell className={cn('text-center', siteTotal.qty !== result.total.qtyDelta && 'text-destructive')}>{siteTotal.qty.toLocaleString('ru-RU')}</TableCell>}
                </TableRow>
                {shown.map(r => (
                  <TableRow key={r.execId || r.fio}>
                    <TableCell className="sticky left-0 bg-card">{r.fio}</TableCell>
                    <TableCell className={cn(r.company === '—' && 'text-muted-foreground')}>{r.company}</TableCell>
                    {variants.map(v => <TableCell key={v.key} className="text-center">{r.values[v.key].toLocaleString('ru-RU')}</TableCell>)}
                    {(() => {
                      const s = siteOf(r)
                      return (
                        <>
                          <TableCell className={cn('text-center font-medium', s.sz !== r.values.srcTgtProduct && 'bg-destructive/10 text-destructive')}>{s.sz.toLocaleString('ru-RU')}</TableCell>
                          {type === 'all' && <TableCell className={cn('text-center font-medium', s.qty !== r.values.qtyDelta && 'bg-destructive/10 text-destructive')}>{s.qty.toLocaleString('ru-RU')}</TableCell>}
                        </>
                      )
                    })()}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {variants.map(v => <li key={v.key}><span className="font-medium text-foreground">{v.group}: {v.label}</span> — {v.hint}</li>)}
          </ul>

          {loaded.sample && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Пример строки WMS (какие поля есть)</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded-xl bg-surface-2 p-3">{JSON.stringify(loaded.sample, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </SettingCard>
  )
}
