// «Сверка комплектации» → почасовой отчёт WMS (монитор активности → отбор)
// рядом с цифрами сайта. Отчёт WMS отбирает задания по времени СОЗДАНИЯ
// (createdAtFrom/To) и делит их на «всего / выполнено / осталось», а сайт и
// PowerBI считают выполненное по времени ВЫПОЛНЕНИЯ — отсюда разница по часам.
// Полный ответ WMS показан ниже таблицы: какие ещё поля в нём есть (отменённые
// и т. п.) — видно там.
import { useState } from 'react'
import { toast } from 'sonner'
import { getStoredToken, getReportMonitoringStats } from '@/lib/wmsFetch'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { shiftWindow } from './powerbiCheck'

const HOUR = 3_600_000
const mskHour = ms => new Date(ms + 3 * HOUR).getUTCHours()
const label = h => `${String(h).padStart(2, '0')}–${String((h + 1) % 24).padStart(2, '0')}`
const n = v => (v == null ? '—' : Number(v).toLocaleString('ru-RU'))

// { всего, выполнено, осталось } по блоку статистики WMS
const pick = block => ({
  total: block?.totalTasks?.tasksCount ?? null,
  done: block?.completedTasks?.tasksCount ?? null,
  rest: block?.remainingTasks?.tasksCount ?? null,
})

export function WmsHourlyCompare({ loaded }) {
  const [rows, setRows] = useState(null)
  const [whole, setWhole] = useState(null)
  const [sample, setSample] = useState(null)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    const token = getStoredToken()
    if (!token) { toast.error('Нет активного WMS-токена — войдите паролем от WMS'); return }
    const { from, to } = shiftWindow(loaded.date, loaded.shift)
    setBusy(true)
    try {
      const starts = Array.from({ length: 12 }, (_, i) => from + i * HOUR)
      const [wholeRes, ...hourRes] = await Promise.all([
        getReportMonitoringStats(token, new Date(from).toISOString(), new Date(to).toISOString()),
        ...starts.map(s => getReportMonitoringStats(token, new Date(s).toISOString(), new Date(s + HOUR).toISOString())),
      ])
      // строки журнала WMS, выполненные в этот час (служебные «ЕО → та же ЕО» — отдельно не выделяем)
      const linesByHour = new Map()
      for (const l of loaded.lines) {
        if (!(l.at >= from && l.at < to)) continue
        const h = mskHour(l.at)
        linesByHour.set(h, (linesByHour.get(h) || 0) + 1)
      }
      setRows(starts.map((s, i) => {
        const h = mskHour(s)
        const v = hourRes[i]?.value
        const site = loaded.siteHours?.get(String(h))
        return {
          h,
          kdk: pick(v?.pickByLineStats),
          storage: pick(v?.pieceSelectionStats),
          siteKdk: site?.kdkTasks ?? 0,
          siteStorage: site?.storageTasks ?? 0,
          lines: linesByHour.get(h) || 0,
        }
      }))
      setWhole({ kdk: pick(wholeRes?.value?.pickByLineStats), storage: pick(wholeRes?.value?.pieceSelectionStats) })
      setSample(hourRes.find(r => r?.value) || wholeRes)
    } catch (err) {
      toast.error('Отчёт WMS: ' + (err.message || err))
    } finally {
      setBusy(false)
    }
  }

  const sum = k => (rows || []).reduce((s, r) => s + (Number(k(r)) || 0), 0)

  return (
    <div className="space-y-2 rounded-2xl border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 basis-64">
          <div className="text-sm font-medium">Почасовой отчёт WMS</div>
          <div className="text-xs text-muted-foreground">
            WMS считает задания по времени создания (всего / выполнено / осталось), сайт и PowerBI — выполненное по времени выполнения
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={run} disabled={busy}>{busy ? 'Запрос…' : 'Запросить по часам'}</Button>
      </div>

      {rows && (
        <div className="overflow-auto rounded-xl border border-line">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead rowSpan={2}>Час</TableHead>
                <TableHead colSpan={3} className="text-center">WMS: КДК (созданы в этот час)</TableHead>
                <TableHead colSpan={3} className="text-center">WMS: хранение (созданы в этот час)</TableHead>
                <TableHead colSpan={2} className="text-center">Сайт: выполнено в этот час</TableHead>
                <TableHead rowSpan={2} className="text-center">Строк журнала WMS</TableHead>
              </TableRow>
              <TableRow>
                {['всего', 'выполнено', 'осталось', 'всего', 'выполнено', 'осталось', 'КДК', 'хранение'].map((t, i) => (
                  <TableHead key={i} className="text-center normal-case">{t}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(r => (
                <TableRow key={r.h}>
                  <TableCell>{label(r.h)}</TableCell>
                  {[r.kdk.total, r.kdk.done, r.kdk.rest, r.storage.total, r.storage.done, r.storage.rest, r.siteKdk, r.siteStorage, r.lines].map((v, i) => (
                    <TableCell key={i} className="text-center">{n(v)}</TableCell>
                  ))}
                </TableRow>
              ))}
              <TableRow className="bg-surface-2/60 font-semibold">
                <TableCell>Сумма часов</TableCell>
                {[r => r.kdk.total, r => r.kdk.done, r => r.kdk.rest, r => r.storage.total, r => r.storage.done, r => r.storage.rest, r => r.siteKdk, r => r.siteStorage, r => r.lines].map((k, i) => (
                  <TableCell key={i} className="text-center">{n(sum(k))}</TableCell>
                ))}
              </TableRow>
              {whole && (
                <TableRow className="font-semibold">
                  <TableCell>Вся смена одним запросом</TableCell>
                  {[whole.kdk.total, whole.kdk.done, whole.kdk.rest, whole.storage.total, whole.storage.done, whole.storage.rest].map((v, i) => (
                    <TableCell key={i} className="text-center">{n(v)}</TableCell>
                  ))}
                  <TableCell colSpan={3} />
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {sample && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Полный ответ WMS за один час (какие поля есть)</summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-xl bg-surface-2 p-3">{JSON.stringify(sample, null, 2)}</pre>
        </details>
      )}
    </div>
  )
}
