import { useState } from 'react'
import { DateRangePicker } from '@/components/ui/date-picker'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { fetchRkFromWms, getStoredToken } from '@/lib/wmsFetch'

// Загрузка маршрутов из wwh.samokat.ru ТРЕБУЕТ настоящий токен браузерной сессии
// пользователя в WMS (см. PLAN.md — единственное легитимное место для JS в этом
// проекте). Токен появляется в localStorage, только если при входе указан пароль
// от WMS и он совпал (AuthContext.jsx кладёт его сюда же) — если пользователь
// вошёл сайт-паролем без WMS-ветки (allowWithoutToken) или токен истёк без
// живого refresh-токена, тут по-прежнему честная ошибка, а не притворство.

function todayOffsetIso(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

export default function FetchModal({ open, onOpenChange, onDone }) {
  const [dateFrom, setDateFrom] = useState(todayOffsetIso(-1))
  const [dateTo, setDateTo] = useState(todayOffsetIso(1))
  const [result, setResult] = useState('')
  const [loading, setLoading] = useState(false)

  const handleFetch = async () => {
    if (!dateFrom || !dateTo) { setResult('Выберите даты'); return }
    const token = getStoredToken()
    if (!token) {
      setResult('Нет токена WMS-сессии — эта песочница не подключена к логину. В основном приложении нужно войти заново.')
      return
    }
    setLoading(true)
    setResult('Загружаю маршруты из WMS...')
    try {
      const res = await fetchRkFromWms({ dateFrom, dateTo, token, onProgress: setResult })
      if (res.ok) {
        setResult(`Маршрутов: ${res.routes}, добавлено: ${res.added}, обновлено: ${res.updated}`)
        setTimeout(() => { onOpenChange(false); onDone?.() }, 1500)
      } else {
        setResult(`Ошибка: ${res.error}`)
      }
    } catch (err) {
      setResult(`Ошибка: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Загрузка из WMS</DialogTitle>
          <DialogDescription>Загрузит маршруты за период и сохранит в базу</DialogDescription>
        </DialogHeader>

        <DateRangePicker from={dateFrom} to={dateTo} onChange={({ from, to }) => { setDateFrom(from); setDateTo(to) }} className="w-full" />

        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
          <span>Тянет данные напрямую из браузера пользователя в wwh.samokat.ru — единственное место, где в проекте остаётся JS-парсинг (см. PLAN.md).</span>
        </div>

        {result && <div className="text-sm text-muted-foreground">{result}</div>}

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Закрыть</Button>
          <Button disabled={loading} onClick={handleFetch}>
            {loading ? <Loader2 className="animate-spin" /> : null} Загрузить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
