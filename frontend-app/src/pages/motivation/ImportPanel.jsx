import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { nowTimeStr, parsePeopleText, toReceivedIso, ROLE_LABELS } from './format'

const selectClass = 'h-8 rounded-md border border-input bg-transparent px-2 text-sm'

// Приём списка «человек из акта → учётка» от подрядчика. Время получения
// по умолчанию — сейчас, но его можно поправить (список пришёл в мессенджер
// в 9:50, а внесли в 10:20 — подрядчик не должен за это отвечать).
export function ImportPanel({ date, shift, companies, accountIndex, onSaved }) {
  const [company, setCompany] = useState('')
  const [receivedTime, setReceivedTime] = useState(nowTimeStr)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)

  const parsed = useMemo(() => parsePeopleText(text, accountIndex), [text, accountIndex])
  const unmatched = parsed.filter(p => !p.matched).length
  const withoutAccount = parsed.filter(p => !p.accountText).length

  const save = async () => {
    if (!company) { toast.error('Выберите компанию'); return }
    if (!parsed.length) { toast.error('Вставьте список: по строке на человека'); return }
    setSaving(true)
    try {
      await api.addMotivationPeople({
        date,
        shift,
        receivedAt: toReceivedIso(date, shift, receivedTime),
        people: parsed.map(p => ({
          company, fio: p.fio, role: p.role, executorId: p.executorId, executorName: p.executorName,
        })),
      })
      toast.success(`Добавлено: ${parsed.length}`)
      setText('')
      onSaved()
    } catch (err) {
      toast.error(err.message)
    }
    setSaving(false)
  }

  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Учётки от подрядчика</div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm">
          <span className="block text-xs text-muted-foreground">Компания</span>
          <select className={selectClass} value={company} onChange={e => setCompany(e.target.value)}>
            <option value="">— выберите —</option>
            {companies.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="block text-xs text-muted-foreground">Список получен в</span>
          <Input type="time" className="h-8 w-28" value={receivedTime} onChange={e => setReceivedTime(e.target.value)} />
        </label>
      </div>
      <Textarea
        className="mt-3 min-h-28 font-mono text-xs"
        placeholder={'По строке на человека: ФИО из акта ; учётка (ID или ФИО учётки) ; роль\nИванов Иван Иванович ; 1234567\nПетров Пётр ; Сидоров Сидор Сидорович\nКузнецов Алексей ; ; грузчик'}
        value={text}
        onChange={e => setText(e.target.value)}
      />
      {parsed.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary">Строк: {parsed.length}</Badge>
            {withoutAccount > 0 && <Badge variant="destructive">Без учётки: {withoutAccount}</Badge>}
            {unmatched > 0 && <Badge variant="warning">Учётка не найдена в справочнике: {unmatched}</Badge>}
          </div>
          <div className="max-h-56 overflow-auto rounded-md border text-xs">
            <table className="w-full">
              <tbody>
                {parsed.map((p, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="px-2 py-1">{p.fio}</td>
                    <td className="px-2 py-1">
                      {!p.accountText && <span className="text-destructive">нет учётки</span>}
                      {p.accountText && p.matched && <span>{p.executorName} <span className="text-muted-foreground">({p.executorId})</span></span>}
                      {p.accountText && !p.matched && <span className="text-warning-foreground">«{p.executorName}» — будет искаться по имени в WMS</span>}
                    </td>
                    <td className="px-2 py-1 text-muted-foreground">{ROLE_LABELS[p.role]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="mt-3">
        <Button size="sm" onClick={save} disabled={saving || !parsed.length}>Сохранить в смену</Button>
      </div>
    </div>
  )
}
