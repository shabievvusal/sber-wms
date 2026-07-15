import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  deleteZoneOverride, getZoneOverrides, pickTextColor, saveZoneOverride, zoneColor, zoneLabel,
} from '@/pages/stats/format'
import { SettingCard } from './SettingCard'
import { MapPin, Plus, Trash2 } from 'lucide-react'

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
  const [newColor, setNewColor] = useState('#1d4ed8')

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
    toast.success(`Зона «${key}» — переопределение удалено`)
  }

  const handleAdd = () => {
    const key = newKey.trim().toUpperCase()
    if (!key) { toast.error('Введите ключ зоны'); return }
    if (overrides[key]) { toast.error('Такая зона уже зарегистрирована'); return }
    const label = newLabel.trim() || key
    saveZoneOverride(key, { label, light: newColor, text: pickTextColor(newColor) })
    setOverrides(prev => ({ ...prev, [key]: { label, light: newColor, text: pickTextColor(newColor) } }))
    setNewKey(''); setNewLabel(''); setNewColor('#1d4ed8')
    toast.success(`Зона «${key}» добавлена`)
  }

  return (
    <SettingCard icon={MapPin} title="Зоны комплектации" subtitle="Название и цвет зон для раздела «Статистика» — без правки кода">
      <div className="space-y-3">
        {keys.length === 0 && (
          <div className="text-sm text-muted-foreground">
            Своих зон пока нет — неизвестные зоны из данных получают автоматический цвет и подпись по ключу.
          </div>
        )}
        {keys.length > 0 && (
          <>
            {/* Мобильные карточки — до md (768px) */}
            <div className="divide-y rounded-md border md:hidden">
              {keys.map(key => {
                const z = overrides[key]
                return (
                  <div key={key} className="space-y-2 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{key}</span>
                      <div className="flex items-center gap-2">
                        <span className="rounded px-2 py-1 text-xs font-medium" style={{ backgroundColor: z.light, color: z.text }}>{z.label}</span>
                        <Button size="icon" variant="ghost" title="Удалить переопределение" onClick={() => handleDelete(key)}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input className="h-8 flex-1" value={z.label} onChange={e => handleSave(key, { label: e.target.value })} />
                      <input
                        type="color"
                        className="h-8 w-12 shrink-0 cursor-pointer rounded border p-0.5"
                        value={z.light}
                        onChange={e => handleSave(key, { light: e.target.value, text: pickTextColor(e.target.value) })}
                      />
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Десктопная таблица — от md и шире */}
            <div className="hidden overflow-hidden rounded-md border md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30 text-xs text-muted-foreground">
                    <th className="p-2 text-left font-medium">Ключ</th>
                    <th className="p-2 text-left font-medium">Название</th>
                    <th className="p-2 text-left font-medium">Цвет</th>
                    <th className="p-2 text-left font-medium">Превью</th>
                    <th className="w-10 p-2" />
                  </tr>
                </thead>
                <tbody>
                  {keys.map(key => {
                    const z = overrides[key]
                    return (
                      <tr key={key} className="border-b last:border-0">
                        <td className="p-2 font-mono text-xs">{key}</td>
                        <td className="p-2">
                          <Input className="h-8 w-48" value={z.label} onChange={e => handleSave(key, { label: e.target.value })} />
                        </td>
                        <td className="p-2">
                          <input
                            type="color"
                            className="h-8 w-12 cursor-pointer rounded border p-0.5"
                            value={z.light}
                            onChange={e => handleSave(key, { light: e.target.value, text: pickTextColor(e.target.value) })}
                          />
                        </td>
                        <td className="p-2">
                          <span className="rounded px-2 py-1 text-xs font-medium" style={{ backgroundColor: z.light, color: z.text }}>{z.label}</span>
                        </td>
                        <td className="p-2 text-right">
                          <Button size="icon" variant="ghost" title="Удалить переопределение" onClick={() => handleDelete(key)}>
                            <Trash2 className="size-3.5" />
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="flex flex-wrap items-end gap-2 border-t pt-3">
          <label className="space-y-1 text-sm">
            <span className="block text-xs text-muted-foreground">Ключ зоны</span>
            <Input className="h-8 w-28 font-mono" placeholder="напр. KDX" value={newKey} onChange={e => setNewKey(e.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="block text-xs text-muted-foreground">Название</span>
            <Input className="h-8 w-48" placeholder="напр. Новая зона" value={newLabel} onChange={e => setNewLabel(e.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="block text-xs text-muted-foreground">Цвет</span>
            <input type="color" className="h-8 w-12 cursor-pointer rounded border p-0.5" value={newColor} onChange={e => setNewColor(e.target.value)} />
          </label>
          <Button size="sm" onClick={handleAdd}><Plus className="size-3.5" /> Добавить зону</Button>
        </div>

        <p className="text-xs text-muted-foreground">
          Пример неизвестной зоны без переопределения: <span className="rounded px-1.5 py-0.5 font-medium" style={{ backgroundColor: zoneColor('XYZ').light, color: zoneColor('XYZ').text }}>{zoneLabel('XYZ')}</span> — цвет и подпись подобрались сами.
        </p>
      </div>
    </SettingCard>
  )
}
