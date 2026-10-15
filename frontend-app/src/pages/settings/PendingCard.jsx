import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { SettingCard } from './SettingCard'
import { rolesOrBuiltin } from './constants'
import { Avatar, IconAction } from './ui'
import { Check, UserPlus, X } from 'lucide-react'
import { confirmDialog } from '@/components/ui/confirm'
import { useAuth } from '@/context/AuthContext'
import { shortWarehouseName } from '@/lib/warehouse'

function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function PendingCard({ roles, onApproved }) {
  const [pending, setPending] = useState([])
  const [loading, setLoading] = useState(true)
  const [roleFor, setRoleFor] = useState({})
  const [busy, setBusy] = useState({})
  const { user: me } = useAuth()
  const myWarehouses = me?.warehouses || []
  const whName = id => shortWarehouseName(myWarehouses.find(w => w.id === id)?.name || '')

  const load = () => {
    setLoading(true)
    return api.getVsAdminPending()
      .then(setPending)
      .catch(() => setPending([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const handleApprove = async phone => {
    const role = roleFor[phone] || 'manager'
    setBusy(b => ({ ...b, [phone]: true }))
    try {
      await api.approveVsPending(phone, role)
      setPending(prev => prev.filter(p => p.phone !== phone))
      toast.success('Доступ одобрен')
      onApproved?.()
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setBusy(b => ({ ...b, [phone]: false }))
    }
  }

  const handleReject = async phone => {
    if (!(await confirmDialog({ title: 'Отклонить заявку?', description: 'Заявка будет удалена. Человек сможет подать её заново.', confirmText: 'Отклонить', danger: true }))) return
    try {
      await api.rejectVsPending(phone)
      setPending(prev => prev.filter(p => p.phone !== phone))
      toast.success('Заявка отклонена')
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    }
  }

  if (loading || !pending.length) return null

  return (
    <SettingCard
      icon={UserPlus}
      title={`Заявки на доступ · ${pending.length}`}
      subtitle="Выберите роль и одобрите — пользователь сможет войти на сайт"
      accent
      bodyClassName="p-2"
    >
      <ul>
        {pending.map(p => (
          <li key={p.phone} className="flex flex-wrap items-center gap-3 rounded-2xl px-3 py-2.5 transition-colors hover:bg-surface-2/50">
            <Avatar name={p.name} className="size-10 text-sm" />
            <div className="min-w-0 flex-1 basis-48">
              <div className="truncate text-sm font-medium">{p.name || 'Без имени'}</div>
              <div className="tabular text-xs text-muted-foreground">{p.phone} · заявка {fmtDateTime(p.registeredAt)}{myWarehouses.length > 1 && p.warehouseId ? ` · ${whName(p.warehouseId)}` : ''}</div>
            </div>
            <Select className="h-8 w-48" value={roleFor[p.phone] || 'manager'} onChange={e => setRoleFor(r => ({ ...r, [p.phone]: e.target.value }))}>
              {rolesOrBuiltin(roles).map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
            </Select>
            <div className="flex items-center gap-1">
              <Button size="sm" disabled={busy[p.phone]} onClick={() => handleApprove(p.phone)}>
                <Check className="size-3.5" /> {busy[p.phone] ? 'Одобряю…' : 'Одобрить'}
              </Button>
              <IconAction icon={X} title="Отклонить заявку" tone="danger" onClick={() => handleReject(p.phone)} />
            </div>
          </li>
        ))}
      </ul>
    </SettingCard>
  )
}
