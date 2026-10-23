import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { getStoredToken, fetchDataViaBrowser, fetchRemainsViaBrowser, fetchStockMovesViaBrowser, fetchReceivingViaBrowser, mergeNewEmployees } from '@/lib/wmsFetch'
import { NewEmployeesNotice } from './NewEmployeesNotice'
import { Button } from '@/components/ui/button'
import { DateRangePicker } from '@/components/ui/date-picker'
import { SettingCard } from './SettingCard'
import { Field } from './ui'
import { CalendarRange, RefreshCw, Square } from 'lucide-react'

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function datesBetween(from, to) {
  const out = []
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

// Обе смены даты целиком: дневная 09:00–21:00 + ночная 21:00–09:00 следующего
// дня (по Москве) — так же, как смены считает вся статистика. Раньше грузились
// сутки 00:00–24:00: у последнего дня периода терялась вторая половина ночи,
// а первый день цеплял хвост ночи предыдущей, невыбранной даты.
function moscowShiftsRange(date) {
  const from = new Date(`${date}T09:00:00+03:00`)
  return { from: from.toISOString(), to: new Date(from.getTime() + 24 * 60 * 60 * 1000 - 1).toISOString() }
}

const MAX_DAYS = 31

// Разделы: run(token, {from, to}) → { text: итог за день, newEmployees }.
const DOMAINS = [
  {
    key: 'selection', label: 'Комплектация', defaultOn: true,
    run: async (token, r) => {
      const res = await fetchDataViaBrowser(token, { operationCompletedAtFrom: r.from, operationCompletedAtTo: r.to })
      return { text: `${res.fetched}/+${res.added}`, newEmployees: res.newEmployees }
    },
  },
  {
    key: 'remains', label: 'Остатки', defaultOn: true,
    run: async (token, r) => {
      const res = await fetchRemainsViaBrowser(token, { dateFrom: r.from, dateTo: r.to })
      return { text: `${res.fetched}/+${res.added}`, newEmployees: res.newEmployees }
    },
  },
  {
    key: 'moves', label: 'Спуск, пополнение, размещение', defaultOn: true,
    run: async (token, r) => {
      const res = await fetchStockMovesViaBrowser(token, { dateFrom: r.from, dateTo: r.to })
      return { text: `${res.fetched}/+${res.added}`, newEmployees: res.newEmployees }
    },
  },
  {
    // Выключена по умолчанию: за приёмщиком — запрос в WMS на каждую новую поставку.
    key: 'receiving', label: 'Приёмка', defaultOn: false,
    run: async (token, r) => {
      const res = await fetchReceivingViaBrowser(token, { completedDateFrom: r.from, completedDateTo: r.to })
      return { text: `${res.fetched}/+${res.saved}`, newEmployees: res.newEmployees }
    },
  },
]

// Только admin/developer (см. SettingsPage.jsx) — перезагрузка статистики из
// WMS за несколько дней разом: по дням, по очереди, с возможностью остановить.
// Повторная загрузка дня не создаёт дублей — сохранение сливает строки по id.
export function StatsPeriodRefreshCard() {
  const [dateFrom, setDateFrom] = useState(todayStr())
  const [dateTo, setDateTo] = useState(todayStr())
  const [enabled, setEnabled] = useState(() => Object.fromEntries(DOMAINS.map(d => [d.key, d.defaultOn])))
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState([])
  const [newEmployees, setNewEmployees] = useState([])
  const stopRef = useRef(false)

  // В календаре периода выбран только первый день — это период из одного дня.
  const lastDay = dateTo || dateFrom
  const days = dateFrom && lastDay >= dateFrom ? datesBetween(dateFrom, lastDay) : []
  const activeDomains = DOMAINS.filter(d => enabled[d.key])
  const canRun = !running && days.length > 0 && days.length <= MAX_DAYS && activeDomains.length > 0

  const handleRun = async () => {
    const token = getStoredToken()
    if (!token) { toast.error('Нет активного WMS-токена — войдите паролем от WMS'); return }
    stopRef.current = false
    setRunning(true)
    setLog(days.map(date => ({ date, status: 'wait', parts: {} })))
    let failed = 0
    for (let i = 0; i < days.length; i++) {
      if (stopRef.current) break
      const date = days[i]
      setLog(prev => prev.map((row, j) => j === i ? { ...row, status: 'run' } : row))
      const range = moscowShiftsRange(date)
      const parts = {}
      for (const d of activeDomains) {
        if (stopRef.current) break
        try {
          // Токен WMS живёт ~5 минут, AuthContext продлевает его сам и кладёт
          // свежий в localStorage — берём заново перед каждым шагом, иначе
          // загрузка периода падала бы с 401 через несколько минут.
          const fresh = getStoredToken()
          if (!fresh) throw new Error('WMS-токен истёк — войдите паролем от WMS')
          const res = await d.run(fresh, range)
          parts[d.key] = res.text
          if (res.newEmployees?.length) setNewEmployees(prev => mergeNewEmployees(prev, res.newEmployees))
        } catch (err) {
          parts[d.key] = `ошибка: ${err.message}`
          failed++
        }
        setLog(prev => prev.map((row, j) => j === i ? { ...row, parts: { ...parts } } : row))
      }
      setLog(prev => prev.map((row, j) => j === i ? { ...row, status: stopRef.current ? 'stopped' : 'done' } : row))
    }
    setRunning(false)
    if (stopRef.current) toast('Обновление остановлено')
    else if (failed) toast.error(`Готово, но с ошибками: ${failed}`)
    else toast.success(`Статистика обновлена за ${days.length} дн.`)
  }

  return (
    <SettingCard
      icon={CalendarRange}
      title="Обновление статистики за период"
      subtitle="Заново загружает данные из WMS по дням — для пропущенных или неполных дней"
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Период">
          <DateRangePicker className="w-56" from={dateFrom} to={dateTo} onChange={({ from, to }) => { setDateFrom(from); setDateTo(to) }} disabled={running} />
        </Field>
        {running
          ? <Button variant="outline" onClick={() => { stopRef.current = true }}><Square className="size-4" /> Остановить</Button>
          : <Button variant="outline" disabled={!canRun} onClick={handleRun}><RefreshCw className="size-4" /> Обновить {days.length > 0 ? `(${days.length} дн.)` : ''}</Button>}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {DOMAINS.map(d => (
          <label key={d.key} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!enabled[d.key]}
              disabled={running}
              onChange={e => setEnabled(prev => ({ ...prev, [d.key]: e.target.checked }))}
            />
            {d.label}
          </label>
        ))}
      </div>

      {days.length > MAX_DAYS && <div className="mt-3 text-sm text-destructive">Не больше {MAX_DAYS} дней за раз.</div>}

      {log.length > 0 && (
        <div className="mt-4 max-h-72 overflow-y-auto rounded-2xl border p-3 text-sm">
          {log.map(row => (
            <div key={row.date} className="flex flex-wrap gap-x-3 py-0.5">
              <span className="tabular w-24 shrink-0 font-medium">{row.date.split('-').reverse().join('.')}</span>
              <span className="w-16 shrink-0 text-muted-foreground">
                {{ wait: 'в очереди', run: 'загрузка…', done: 'готово', stopped: 'остановлено' }[row.status]}
              </span>
              <span className="text-muted-foreground">
                {activeDomains.filter(d => row.parts[d.key]).map(d => `${d.label}: ${row.parts[d.key]}`).join(' · ')}
              </span>
            </div>
          ))}
        </div>
      )}

      <NewEmployeesNotice employees={newEmployees} onDone={() => setNewEmployees([])} />

      <p className="mt-4 text-xs text-muted-foreground">
        Каждый день — обе его смены: дневная и ночная (до 09:00 следующего дня). Цифры — «получено из WMS / добавлено новых». Повторная загрузка дня дублей не создаёт. Приёмка тяжёлая: по каждой новой поставке — отдельный запрос в WMS за приёмщиком.
      </p>
    </SettingCard>
  )
}
