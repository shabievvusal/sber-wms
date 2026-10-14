import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EditableCell } from '@/components/ui/editable-cell'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  deleteZoneOverride, getZoneOverrides, pickTextColor, saveZoneOverride, zoneColor, zoneLabel,
} from '@/pages/stats/format'
import { SettingCard } from './SettingCard'
import { Empty, IconAction, theadCls, thCls, trCls, tableWrapCls } from './ui'
import { Check, MapPin, Plus, Trash2 } from 'lucide-react'

// Светлые фоны меток зон — текст на них подбирается сам (pickTextColor)
const PRESETS = [
  '#dbeafe', '#bfdbfe', '#c7d2fe', '#ddd6fe', '#fbcfe8', '#fecaca',
  '#fed7aa', '#fde68a', '#d9f99d', '#bbf7d0', '#a5f3fc', '#e2e8f0',
  '#1d4ed8', '#7c3aed', '#be185d', '#b91c1c', '#c2410c', '#047857',
]

/** Образец цвета: палитра готовых + «свой цвет» через системный выбор. */
function ColorSwatch({ value, onChange, title = 'Цвет' }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={title}
          className="grid size-8 shrink-0 place-items-center rounded-lg border border-line-strong shadow-card transition-transform hover:scale-105"
          style={{ background: value }}
        />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-3">
        <div className="grid grid-cols-6 gap-1.5">
          {PRESETS.map(c => (
            <button
              key={c}
              type="button"
              onClick={() => { onChange(c); setOpen(false) }}
              className={cn('grid size-7 place-items-center rounded-md border border-line transition-transform hover:scale-110')}
              style={{ background: c, color: pickTextColor(c) }}
              title={c}
            >
              {value?.toLowerCase() === c && <Check className="size-3.5" strokeWidth={3} />}
            </button>
          ))}
        </div>
        <label className="mt-3 flex cursor-pointer items-center gap-2 rounded-lg px-1 py-1 text-xs text-muted-foreground hover:text-foreground">
          <input type="color" className="size-6 cursor-pointer rounded border-0 bg-transparent p-0" value={value} onChange={e => onChange(e.target.value)} />
          Свой цвет…
        </label>
      </PopoverContent>
    </Popover>
  )
}

function ZoneTag({ zone }) {
  return <span className="rounded-md px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: zone.light, color: zone.text }}>{zone.label}</span>
}

// Карточка для раздела «Статистика»: без переопределения зоны получают
// известную подпись (для знакомых ключей) и цвет по хэшу ключа — работает
// «из коробки» для любой зоны из данных, но админ/разработчик может здесь
// задать своё название и цвет для конкретного ключа (или зарегистрировать
// зону заранее, до того как она появится в данных) — не трогая код
// (см. PLAN.md, решение пользователя от 2026-07-12).
export function ZonesSettingsCard() {
  const [overrides, setOverrides] = useState(() => getZoneOverrides())
  const [newKey, setNewKey] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newColor, setNewColor] = useState('#dbeafe')

  const keys = Object.keys(overrides).sort()

  const handleSave = (key, patch) => {
    const current = overrides[key] || {}
    const next = { ...current, ...patch }
    if (!next.text) next.text = pickTextColor(next.light)
    saveZoneOverride(key, next)
    setOverrides(prev => ({ ...prev, [key]: next }))
  }

  const handleDelete = key => {
    deleteZoneOverride(key)
    setOverrides(prev => { const next = { ...prev }; delete next[key]; return next })
    toast.success(`Зона «${key}» — своё оформление убрано`)
  }

  const handleAdd = () => {
    const key = newKey.trim().toUpperCase()
    if (!key) { toast.error('Введите ключ зоны'); return }
    if (overrides[key]) { toast.error('Такая зона уже есть'); return }
    const label = newLabel.trim() || key
    const z = { label, light: newColor, text: pickTextColor(newColor) }
    saveZoneOverride(key, z)
    setOverrides(prev => ({ ...prev, [key]: z }))
    setNewKey(''); setNewLabel(''); setNewColor('#dbeafe')
    toast.success(`Зона «${key}» добавлена`)
  }

  const example = zoneColor('XYZ')

  return (
    <SettingCard icon={MapPin} title="Зоны комплектации" subtitle="Название и цвет зон в «Статистике». Остальные зоны получают цвет автоматически.">
      {keys.length === 0 ? (
        <Empty>
          Своих зон пока нет. Например, неизвестная зона выглядит так:{' '}
          <span className="rounded-md px-1.5 py-0.5 font-medium" style={{ backgroundColor: example.light, color: example.text }}>{zoneLabel('XYZ')}</span>
        </Empty>
      ) : (
        <div className={tableWrapCls}>
          <table className="w-full text-sm">
            <thead className={theadCls}>
              <tr className="border-b border-line">
                <th className={cn(thCls, 'w-28')}>Ключ</th>
                <th className={thCls}>Название</th>
                <th className={cn(thCls, 'w-20')}>Цвет</th>
                <th className={cn(thCls, 'w-40')}>Как выглядит</th>
                <th className="w-12" />
              </tr>
            </thead>
            <tbody>
              {keys.map(key => {
                const z = overrides[key]
                return (
                  <tr key={key} className={trCls}>
                    <td className="px-3 py-1.5 font-mono text-xs">{key}</td>
                    <td className="px-1 py-1.5"><EditableCell value={z.label} placeholder={key} onCommit={v => handleSave(key, { label: v.trim() || key })} /></td>
                    <td className="px-3 py-1.5"><ColorSwatch value={z.light} onChange={c => handleSave(key, { light: c, text: pickTextColor(c) })} /></td>
                    <td className="px-3 py-1.5"><ZoneTag zone={z} /></td>
                    <td className="py-1.5 pr-2 text-right">
                      <IconAction icon={Trash2} title="Убрать своё оформление" tone="danger" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => handleDelete(key)} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <form className="mt-4 flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); handleAdd() }}>
        <Input className="w-28 font-mono uppercase" placeholder="Ключ" value={newKey} onChange={e => setNewKey(e.target.value)} />
        <Input className="min-w-0 flex-1 basis-48 sm:max-w-xs" placeholder="Название, напр. Новая зона" value={newLabel} onChange={e => setNewLabel(e.target.value)} />
        <ColorSwatch value={newColor} onChange={setNewColor} title="Цвет новой зоны" />
        {newKey.trim() && <ZoneTag zone={{ label: newLabel.trim() || newKey.trim().toUpperCase(), light: newColor, text: pickTextColor(newColor) }} />}
        <Button type="submit" variant="outline" disabled={!newKey.trim()}><Plus className="size-4" /> Добавить зону</Button>
      </form>
    </SettingCard>
  )
}
