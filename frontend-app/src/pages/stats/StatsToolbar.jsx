import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DatePicker } from '@/components/ui/date-picker'
import { OPERATIONS } from './constants'
import { formatTime, getCurrentShiftInfo } from './format'
import { RefreshCw, Send, RotateCcw } from 'lucide-react'

const selectClass = 'h-8 rounded-md border border-input bg-transparent px-2 text-sm'

// Тулбар перенесён из оригинала (StatsToolbar.jsx) — действия гейтятся по
// роли (`actions`), как и в оригинале (`fetch_data`/`recheck_data`/
// `request_fetch`), через локальный предпросмотр роли в StatsPage.jsx (в
// песочнице нет общей сессии/системы прав — тот же приём, что и ролевой
// предпросмотр в SettingsPage).
export function StatsToolbar({
  dateStr, onDateChange, shift, onShiftChange, operation, onOperationChange,
  fetchHourFrom, fetchHourTo, onFetchHourFromChange, onFetchHourToChange,
  lastUpdated, engineNote, autoFetchEnabled, onFetch, onRequestFetch, onRecheck, fetching, actions,
}) {
  const { dateStr: today } = getCurrentShiftInfo()
  const canFetch = actions.includes('fetch_data')
  const canRecheck = actions.includes('recheck_data')
  const canRequest = actions.includes('request_fetch')

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
      <DatePicker value={dateStr} onChange={e => onDateChange(e.target.value)} max={today} />

      <div className="flex gap-1 rounded-md border bg-muted/30 p-0.5">
        <Button size="sm" variant={shift === 'day' ? 'default' : 'ghost'} onClick={() => onShiftChange('day')}>День (9–21)</Button>
        <Button size="sm" variant={shift === 'night' ? 'default' : 'ghost'} onClick={() => onShiftChange('night')}>Ночь (21–9)</Button>
      </div>

      <select className={selectClass} value={operation} onChange={e => onOperationChange(e.target.value)}>
        {OPERATIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>

      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>Выгрузить с</span>
        <Input className="h-8 w-14" type="number" min="0" max="23" value={fetchHourFrom} onChange={e => onFetchHourFromChange(e.target.value)} />
        <span>до</span>
        <Input className="h-8 w-14" type="number" min="0" max="23" value={fetchHourTo} onChange={e => onFetchHourToChange(e.target.value)} />
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {lastUpdated && <span className="text-xs text-muted-foreground">Обновлено: {formatTime(lastUpdated)}</span>}
        {engineNote && <span className="text-xs text-muted-foreground">{engineNote}</span>}
        {canFetch && (
          <Button size="sm" variant="secondary" onClick={onFetch} disabled={fetching}>
            <RefreshCw className={`size-3.5 ${fetching ? 'animate-spin' : ''}`} /> {fetching ? 'Обновление...' : 'Обновить данные'}
          </Button>
        )}
        {canRequest && !autoFetchEnabled && (
          <Button size="sm" variant="secondary" onClick={onRequestFetch}>
            <Send className="size-3.5" /> Запросить обновление
          </Button>
        )}
        {canRecheck && (
          <Button size="icon" variant="ghost" title="Перепроверить данные с указанного часа" onClick={onRecheck} disabled={fetching}>
            <RotateCcw className={`size-3.5 ${fetching ? 'animate-spin' : ''}`} />
          </Button>
        )}
      </div>
    </div>
  )
}
