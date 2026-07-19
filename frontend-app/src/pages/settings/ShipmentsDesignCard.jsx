import { useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { SettingCard, SettingRow } from './SettingCard'
import { Truck } from 'lucide-react'

export const LS_SHIPMENTS_CLASSIC = 'shipments_classic_design'

// Часть делопроизводителей не устроил новый (Tailwind) дизайн раздела
// «Отгрузка» — тумблер возвращает оригинальный вид (ShipmentsPageClassic.jsx),
// только для просмотра/редактирования существующих маршрутов. Как и
// автообновление статистики (AutoFetchCard) — это настройка ЭТОГО браузера/
// устройства (localStorage), а не общая для всех.
export function ShipmentsDesignCard() {
  const [classic, setClassic] = useState(() => {
    try { return localStorage.getItem(LS_SHIPMENTS_CLASSIC) === '1' } catch { return false }
  })

  const handleToggle = val => {
    setClassic(val)
    try { localStorage.setItem(LS_SHIPMENTS_CLASSIC, val ? '1' : '0') } catch { /* ignore */ }
  }

  return (
    <SettingCard icon={Truck} title="Дизайн «Отгрузки»" subtitle="Внешний вид раздела «Отгрузка» на этом устройстве">
      <SettingRow
        label="Классический вид"
        desc="Таблица и форма редактирования в старом (оригинальном) оформлении вместо текущего"
      >
        <Switch checked={classic} onCheckedChange={handleToggle} />
      </SettingRow>
    </SettingCard>
  )
}
