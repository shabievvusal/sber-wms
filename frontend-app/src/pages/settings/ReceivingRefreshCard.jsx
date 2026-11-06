import { useState } from 'react'
import { toast } from 'sonner'
import { getStoredToken, fetchReceivingViaBrowser, mergeNewEmployees } from '@/lib/wmsFetch'
import { NewEmployeesNotice } from './NewEmployeesNotice'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import { SettingCard } from './SettingCard'
import { Field } from './ui'
import { Copy, PackageCheck, RefreshCw } from 'lucide-react'

const REASON = { mismatch: 'штуки не сошлись с журналом', noJournal: 'ЕО нет в журнале', noDetail: 'карточка не открылась' }
const fmtTime = iso => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—')

// Разбор поставок, у которых журнал не подтвердил приёмщика: какие ЕО
// расходятся (карточка / журнал) и вся история WMS по каждой такой ЕО.
function ReceivingIssues({ issues }) {
  const copy = () => navigator.clipboard.writeText(JSON.stringify(issues, null, 2))
    .then(() => toast.success('Разбор скопирован'), () => toast.error('Не удалось скопировать'))
  return (
    <div className="mt-3 space-y-3 rounded-xl border border-line p-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Разбор несошедшихся поставок</span>
        <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={copy}><Copy className="size-3.5" /> Скопировать</Button>
      </div>
      {issues.map(it => (
        <div key={it.id} className="space-y-1.5 border-t border-line pt-2">
          <div>
            <span className="font-semibold">Задание {it.taskNumber || it.id}</span>
            {it.orderNumber && <> · заказ {it.orderNumber}</>}
            {it.supplier && <> · {it.supplier}</>}
            {it.gate && <> · ворота {it.gate}</>}
          </div>
          <div className="text-muted-foreground">
            {REASON[it.reason] || it.reason} · приёмка {fmtTime(it.startedAt)} → {fmtTime(it.completedAt)} · приёмщик (из WMS): {it.acceptor || '—'}
            {it.factPieces != null && <> · штук по карточке {it.factPieces}, по журналу {it.journalPieces} · ЕО в поставке {it.huCount}</>}
          </div>
          {(it.diffs || []).map(d => (
            <div key={d.hu} className="rounded-lg bg-surface-2/60 p-2">
              <div><span className="font-mono">{d.hu}</span>: по карточке {d.fact} шт, по журналу приёмки {d.journal} шт</div>
              {d.historyError && <div className="text-destructive">история не загрузилась: {d.historyError}</div>}
              {d.history && (d.history.length
                ? (
                  <table className="mt-1 w-full">
                    <tbody>
                      {d.history.map((h, i) => (
                        <tr key={i} className="align-top">
                          <td className="pr-2 whitespace-nowrap">{fmtTime(h.at)}</td>
                          <td className="pr-2">{h.op}</td>
                          <td className="pr-2 text-center">{h.dir === 'in' ? 'в ЕО' : 'из ЕО'}</td>
                          <td className="pr-2 text-center">{h.old ?? '—'} → {h.new ?? '—'}</td>
                          <td className="pr-2">{h.cell}</td>
                          <td className="pr-2 font-mono">{h.other}</td>
                          <td className="pr-2">{h.product}</td>
                          <td>{h.user}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
                : <div className="text-muted-foreground">в истории WMS за 3 дня до приёмки и сутки после операций нет</div>)}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Сутки по Москве, 00:00–24:00 — поставки сохраняются по времени
// завершения, на смены их делит только статистика.
function dayRange(date) {
  const from = new Date(`${date}T00:00:00+03:00`)
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000 - 1)
  return { completedDateFrom: from.toISOString(), completedDateTo: to.toISOString() }
}

// Только admin/developer (см. SettingsPage.jsx). Статистика приёмки не входит
// в обычное «Обновить данные» — обновляем вручную, по одному дню. Приёмщик —
// из журнала приёмки WMS (stocks/changes, RECEIVING), сверенный по ЕО и штукам
// с карточкой поставки; не сошлось — запрос приёмщика (см. fetchReceivingViaBrowser).
// Оригинал: «чтобы узнать приёмщика, WMS нужно спросить по каждой поставке отдельно».
export function ReceivingRefreshCard() {
  const [date, setDate] = useState(todayStr())
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [result, setResult] = useState(null)
  const [newEmployees, setNewEmployees] = useState([])

  const handleRun = async () => {
    const token = getStoredToken()
    if (!token) { toast.error('Нет активного WMS-токена — войдите паролем от WMS'); return }
    setRunning(true)
    setProgress(null)
    setResult(null)
    try {
      const res = await fetchReceivingViaBrowser(token, { ...dayRange(date), onProgress: setProgress })
      setResult(res)
      if (res.newEmployees?.length) setNewEmployees(prev => mergeNewEmployees(prev, res.newEmployees))
      toast.success(`Приёмка обновлена: поставок ${res.fetched}, новых сохранено ${res.saved}`)
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <SettingCard
      icon={PackageCheck}
      title="Статистика приёмки"
      subtitle="Загружает принятые за день поставки из WMS: поставки, ЕО, SKU, штуки и вес по приёмщикам"
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Дата">
          <DatePicker className="w-44" value={date} onChange={e => setDate(e.target.value)} />
        </Field>
        <Button variant="outline" disabled={running} onClick={handleRun}>
          <RefreshCw className={running ? 'size-4 animate-spin' : 'size-4'} /> {running ? 'Загрузка…' : 'Обновить приёмку'}
        </Button>
      </div>

      {running && progress && (
        <div className="mt-3 text-sm text-muted-foreground">
          Поставок: {progress.total}, уже в базе: {progress.known} · {progress.stage === 'journal'
            ? 'загружаю журнал приёмки…'
            : progress.stage === 'issues' ? 'разбираю несошедшиеся поставки…'
            : <>поставки: {progress.done} из {progress.toEnrich} · сошлось с журналом {progress.byJournal}{progress.requested > 0 && `, запросом ${progress.requested}`}</>}
        </div>
      )}
      {result && (
        <div className="mt-3 text-sm text-muted-foreground">
          Поставок за день: {result.fetched} · уже были в базе: {result.known} · сохранено: {result.saved}
          <br />Приёмщик сверен с журналом по ЕО и штукам: {result.byJournal}
          {result.several > 0 && ` (из них с несколькими приёмщиками: ${result.several} — записан принявший больше штук)`}
          {result.requested > 0 && <>
            <br />Отдельным запросом: {result.requested}
            {[
              result.mismatch > 0 && `штуки не сошлись с журналом — ${result.mismatch}`,
              result.noJournal > 0 && `ЕО нет в журнале — ${result.noJournal}`,
              result.noDetail > 0 && `карточка не открылась — ${result.noDetail}`,
            ].filter(Boolean).join(', ').replace(/^(.)/, ' ($1').replace(/(.)$/, '$1)')}
          </>}
          {result.noAcceptor > 0 && <><br />Без приёмщика: {result.noAcceptor} (в статистике — строка «—»)</>}
        </div>
      )}

      {result?.issues?.length > 0 && <ReceivingIssues issues={result.issues} />}

      <NewEmployeesNotice employees={newEmployees} onDone={() => setNewEmployees([])} />

      <p className="mt-4 text-xs text-muted-foreground">
        По каждой новой поставке открывается её карточка: ЕО и фактически принятые штуки. Приёмщик берётся из журнала приёмки WMS и засчитывается, только если штуки по этим ЕО совпали с фактом. Иначе приёмщик запрашивается у поставки отдельно. Уже сохранённые поставки повторно не запрашиваются.
      </p>
    </SettingCard>
  )
}
