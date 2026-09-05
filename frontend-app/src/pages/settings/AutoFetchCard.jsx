import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { getStoredToken } from '@/lib/wmsFetch'
import { EO_AUTO_REFRESH_MS, readEoLastRun, refreshAllEoNow } from '@/lib/eoAutoRefresh'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingCard, SettingRow } from './SettingCard'
import { RefreshCw } from 'lucide-react'

const LS_KEY = 'vs_auto_fetch_enabled'
const DEFAULT_SETTINGS = { fullRefreshTimes: [], incrementalMinutes: 30, incrementalLookbackMinutes: 40 }
const EO_MINUTES = Math.round(EO_AUTO_REFRESH_MS / 60_000)

function fmtLastRun(ms) {
  if (!ms) return 'на этом устройстве ещё не запускалось'
  const d = new Date(ms)
  const p = n => String(n).padStart(2, '0')
  return `последний проход в ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function AutoFetchCard({ isAdmin }) {
  const [enabled, setEnabled] = useState(() => {
    try { return localStorage.getItem(LS_KEY) === '1' } catch { return false }
  })
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [timesText, setTimesText] = useState('')
  const [saving, setSaving] = useState(false)

  // Ручное обновление списков ЕО — здесь, а не на странице приёмки: сходить в
  // WMS может только устройство с живой WMS-сессией (корп. компьютер), а на
  // нём «Приёмка → Список ЕО» никто не держит открытой. Рядом с тумблером
  // автообновления, потому что это ровно тот же проход, только «сейчас», а не
  // по расписанию.
  const [eoRefreshing, setEoRefreshing] = useState(false)
  const [eoProgress, setEoProgress] = useState(null) // { done, total }
  const [eoLastRun, setEoLastRun] = useState(readEoLastRun)
  const hasWmsToken = Boolean(getStoredToken())

  const handleEoRefresh = async () => {
    setEoRefreshing(true)
    setEoProgress(null)
    try {
      const res = await refreshAllEoNow(getStoredToken(), (done, total) => setEoProgress({ done, total }))
      setEoLastRun(readEoLastRun())
      if (res.total === 0) toast.info('Нет актуальных маршрутов для обновления')
      else if (res.failed) toast.warning(`Обновлено маршрутов: ${res.ok} из ${res.total}, не удалось: ${res.failed}`)
      else toast.success(`Списки ЕО обновлены — маршрутов: ${res.ok}`)
    } catch (err) {
      toast.error('Ошибка: ' + (err.message || 'не удалось обновить списки ЕО'))
    } finally {
      setEoRefreshing(false)
      setEoProgress(null)
    }
  }

  useEffect(() => {
    let cancelled = false
    api.getAutoFetchSettings()
      .then(data => {
        if (cancelled || !data) return
        const next = {
          fullRefreshTimes: Array.isArray(data.fullRefreshTimes) ? data.fullRefreshTimes : [],
          incrementalMinutes: Number(data.incrementalMinutes) || 30,
          incrementalLookbackMinutes: Number(data.incrementalLookbackMinutes) || 40,
        }
        setSettings(next)
        setTimesText(next.fullRefreshTimes.join(', '))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const handleToggle = val => {
    setEnabled(val)
    try { localStorage.setItem(LS_KEY, val ? '1' : '0') } catch { /* ignore */ }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await withMinDuration(async () => {
        const payload = { ...settings, fullRefreshTimes: timesText.split(',').map(x => x.trim()).filter(Boolean) }
        try {
          const saved = await api.updateAutoFetchSettings(payload)
          setSettings(saved)
          setTimesText((saved.fullRefreshTimes || []).join(', '))
        } catch {
          setSettings(payload)
        }
      })
      toast.success('Настройки автообновления сохранены')
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingCard icon={RefreshCw} title="Автообновление" subtitle="Этот браузер будет забирать данные из WMS по расписанию">
      <SettingRow
        label="Автообновление на этом устройстве"
        desc="Включите на одном компьютере — статистика обновится у всех остальных автоматически"
      >
        <Switch checked={enabled} onCheckedChange={handleToggle} />
      </SettingRow>
      <SettingRow
        label="Списки ЕО (приёмка)"
        desc={hasWmsToken
          ? `Обновляются сами каждые ${EO_MINUTES} мин, пока включено автообновление — ${fmtLastRun(eoLastRun)}`
          : 'Нужна активная WMS-сессия на этом устройстве — обновлять может только браузер с WMS-токеном'}
      >
        <Button size="sm" variant="secondary" onClick={handleEoRefresh} disabled={!hasWmsToken || eoRefreshing}>
          <RefreshCw className={`size-3.5 ${eoRefreshing ? 'animate-spin' : ''}`} />
          {eoRefreshing
            ? (eoProgress ? `Обновление... ${eoProgress.done + 1}/${eoProgress.total}` : 'Обновление...')
            : 'Обновить сейчас'}
        </Button>
      </SettingRow>
      <SettingRow
        label="Полный сбор"
        desc={`Короткое обновление: каждые ${settings.incrementalMinutes} мин, окно ${settings.incrementalLookbackMinutes} мин`}
      >
        <div className="flex items-center gap-2">
          <Input
            className="w-40"
            value={timesText}
            onChange={e => setTimesText(e.target.value)}
            placeholder="09:10, 21:10"
            disabled={!isAdmin || saving}
          />
          {isAdmin && (
            <Button size="sm" variant="secondary" onClick={handleSave} disabled={saving}>
              {saving ? 'Сохранение...' : 'Сохранить'}
            </Button>
          )}
        </div>
      </SettingRow>
    </SettingCard>
  )
}
