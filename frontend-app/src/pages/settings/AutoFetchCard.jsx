import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingCard, SettingRow } from './SettingCard'
import { RefreshCw } from 'lucide-react'

const LS_KEY = 'vs_auto_fetch_enabled'
const DEFAULT_SETTINGS = { fullRefreshTimes: [], incrementalMinutes: 30, incrementalLookbackMinutes: 40 }

export function AutoFetchCard({ isAdmin }) {
  const [enabled, setEnabled] = useState(() => {
    try { return localStorage.getItem(LS_KEY) === '1' } catch { return false }
  })
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [timesText, setTimesText] = useState('')
  const [saving, setSaving] = useState(false)

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
