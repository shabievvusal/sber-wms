import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { SettingCard } from './SettingCard'
import { rolesOrBuiltin } from './constants'
import { Clock } from 'lucide-react'

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
    if (!confirm('Отклонить заявку?')) return
    try {
      await api.rejectVsPending(phone)
      setPending(prev => prev.filter(p => p.phone !== phone))
      toast.success('Заявка отклонена')
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    }
  }

  if (!loading && !pending.length) return null

  return (
    <SettingCard icon={Clock} title="Заявки на регистрацию" subtitle="Пользователи, ожидающие одобрения доступа" accent>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ФИО</TableHead>
              <TableHead>Телефон</TableHead>
              <TableHead>Дата заявки</TableHead>
              <TableHead>Роль</TableHead>
              <TableHead className="text-right">Действия</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Загрузка...</TableCell></TableRow>
            ) : pending.map(p => (
              <TableRow key={p.phone}>
                <TableCell className="font-medium">{p.name || '—'}</TableCell>
                <TableCell>{p.phone}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{fmtDateTime(p.registeredAt)}</TableCell>
                <TableCell>
                  <select
                    className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                    value={roleFor[p.phone] || 'manager'}
                    onChange={e => setRoleFor(r => ({ ...r, [p.phone]: e.target.value }))}
                  >
                    {rolesOrBuiltin(roles).map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                  </select>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" disabled={busy[p.phone]} onClick={() => handleApprove(p.phone)}>
                      {busy[p.phone] ? '...' : 'Одобрить'}
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => handleReject(p.phone)}>Отклонить</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SettingCard>
  )
}
