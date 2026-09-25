import { useState } from 'react'
import { toast } from 'sonner'
import { Trash2, Pencil, AlertTriangle, UserPlus } from 'lucide-react'
import * as api from '@/lib/api'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { fmtHours, fmtNum, fmtPct, fmtTime, resolveAccount, STATUS_META } from './format'

const th = 'h-8 px-2 text-[11px] whitespace-nowrap'
const td = 'px-2 py-1.5 text-[13px] whitespace-nowrap'
const num = `${td} text-right tabular-nums`

function AccountCell({ row, accountIndex, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')

  const start = () => { setValue(row.executorId || row.executorName); setEditing(true) }
  const commit = async () => {
    setEditing(false)
    const next = resolveAccount(value, accountIndex)
    if (next.executorId === row.executorId && next.executorName === row.executorName) return
    try {
      await api.updateMotivationPerson(row.id, { executorId: next.executorId, executorName: next.executorName })
      if (!next.matched) toast.warning(`«${next.executorName}» нет в справочнике — будет искаться по имени в WMS`)
      onChanged()
    } catch (err) {
      toast.error(err.message)
    }
  }

  if (editing) {
    return (
      <Input
        autoFocus list="motivation-accounts" className="h-7 w-56 text-xs" value={value}
        placeholder="ID или ФИО учётки"
        onChange={e => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditing(false) }}
      />
    )
  }
  return (
    <button type="button" className="group inline-flex items-center gap-1 text-left" onClick={start}>
      {row.executorId || row.executorName
        ? <span>{row.executorName || row.executorId}{row.executorId && <span className="text-muted-foreground"> · {row.executorId}</span>}</span>
        : <span className="text-destructive">не указана</span>}
      <Pencil className="size-3 opacity-0 group-hover:opacity-60" />
    </button>
  )
}

function RoleCell({ row, onChanged }) {
  const change = async e => {
    try {
      await api.updateMotivationPerson(row.id, { role: e.target.value })
      onChanged()
    } catch (err) {
      toast.error(err.message)
    }
  }
  return (
    <select className="h-7 rounded-md border border-input bg-transparent px-1 text-xs" value={row.role} onChange={change}>
      <option value="picker">Комплект.</option>
      <option value="other">Без нормы</option>
    </select>
  )
}

// readOnly — учётки из статистики без человека в акте (MotivationPage):
// норма посчитана, но редактировать нечего — нет записи в смене. onAdd —
// внести учётки в смену (в акт), когда подрядчик учётки не прислал.
export function ShiftTable({ company, rows, accountIndex, onChanged, readOnly = false, onAdd }) {
  const totalHours = rows.reduce((s, r) => s + (r.hours || 0), 0)
  const zero = rows.filter(r => r.role === 'picker' && (r.hours || 0) === 0).length
  const under = rows.filter(r => r.status === 'under').length
  const over = rows.filter(r => r.status === 'over').length

  const remove = async row => {
    if (!window.confirm(`Удалить «${row.fio}» из смены?`)) return
    try {
      await api.deleteMotivationPerson(row.id)
      onChanged()
    } catch (err) {
      toast.error(err.message)
    }
  }

  return (
    <div className="rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2 text-sm">
        <span className="font-semibold">{company || 'Без компании'}</span>
        <span className="text-xs text-muted-foreground">
          {rows.length} {readOnly ? 'учёт.' : 'чел.'} · {fmtHours(totalHours)} ч{readOnly ? ' по норме' : ' в акт'}
          {under > 0 && <> · <span className="text-destructive">недобор: {under}</span></>}
          {over > 0 && <> · <span className="text-blue-600">перевыполнение: {over}</span></>}
          {!readOnly && zero > 0 && <> · <span className="text-destructive">0 часов: {zero}</span></>}
          {onAdd && (
            <Button size="sm" variant="outline" className="ml-3 h-7" onClick={() => onAdd(rows)}>
              <UserPlus className="size-3.5" /> Внести в акт
            </Button>
          )}
        </span>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={th}>{readOnly ? 'Учётка' : 'ФИО (акт)'}</TableHead>
              {readOnly ? <TableHead className={th}>ID</TableHead> : <>
                <TableHead className={th}>Роль</TableHead>
                <TableHead className={th}>Учётка</TableHead>
                <TableHead className={th}>Получена</TableHead>
              </>}
              <TableHead className={`${th} text-right`}>СЗ ХР</TableHead>
              <TableHead className={`${th} text-right`}>СЗ КДК</TableHead>
              <TableHead className={`${th} text-right`}>Вес ХР, кг</TableHead>
              <TableHead className={`${th} text-right`}>Вес КДК, кг</TableHead>
              <TableHead className={`${th} text-right`} title="Доля нормы по СЗ / по весу. Засчитывается меньшая.">СЗ / вес</TableHead>
              <TableHead className={`${th} text-right`}>Итог</TableHead>
              <TableHead className={`${th} text-right`}>Часы</TableHead>
              <TableHead className={th}>Статус</TableHead>
              {(!readOnly || onAdd) && <TableHead className={th} />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(r => {
              const [label, variant] = STATUS_META[r.status] || [r.status, 'outline']
              const hasStats = r.storageTasks + r.kdkTasks > 0
              return (
                <TableRow key={readOnly ? r.executorId : r.id}>
                  <TableCell className={`${td} font-medium`}>{r.fio}</TableCell>
                  {readOnly ? <TableCell className={`${td} text-muted-foreground`}>{r.executorId}</TableCell> : <>
                    <TableCell className={td}><RoleCell row={r} onChanged={onChanged} /></TableCell>
                    <TableCell className={td}><AccountCell row={r} accountIndex={accountIndex} onChanged={onChanged} /></TableCell>
                    <TableCell className={`${td} ${r.late ? 'font-semibold text-destructive' : ''}`}>{r.receivedAt ? fmtTime(r.receivedAt) : (r.executorId || r.executorName) ? <span className="text-xs text-muted-foreground">из статистики</span> : '—'}</TableCell>
                  </>}
                  <TableCell className={num}>{hasStats ? fmtNum(r.storageTasks) : '—'}</TableCell>
                  <TableCell className={num}>{hasStats ? fmtNum(r.kdkTasks) : '—'}</TableCell>
                  <TableCell className={num}>{hasStats ? fmtNum(r.storageWeightKg) : '—'}</TableCell>
                  <TableCell className={num}>
                    {hasStats ? fmtNum(r.kdkWeightKg) : '—'}
                    {r.missingWeightItems > 0 && (
                      <span title={`Отборов без веса в справочнике: ${r.missingWeightItems} — их вес не учтён`}>
                        <AlertTriangle className="ml-1 inline size-3.5 text-warning-foreground" />
                      </span>
                    )}
                  </TableCell>
                  <TableCell className={num}>{r.pct ? `${fmtPct(r.tasksPct)} / ${fmtPct(r.weightPct)}` : '—'}</TableCell>
                  <TableCell className={`${num} font-medium`}>{r.pct ? fmtPct(r.pct) : '—'}</TableCell>
                  <TableCell className={`${num} font-semibold`}>
                    {fmtHours(r.hours)}
                    {r.deltaHours !== 0 && r.pct > 0 && (
                      <span className={`ml-1 text-xs ${r.deltaHours < 0 ? 'text-destructive' : 'text-blue-600'}`}>
                        ({r.deltaHours > 0 ? '+' : ''}{fmtHours(r.deltaHours)})
                      </span>
                    )}
                  </TableCell>
                  <TableCell className={td}><Badge variant={variant}>{label}</Badge></TableCell>
                  {!readOnly && <TableCell className={td}>
                    <Button variant="ghost" size="icon" className="size-7" onClick={() => remove(r)} title="Удалить из смены">
                      <Trash2 className="size-3.5" />
                    </Button>
                  </TableCell>}
                  {readOnly && onAdd && (
                    <TableCell className={td}>
                      <Button variant="ghost" size="icon" className="size-7" onClick={() => onAdd([r])} title="Внести в акт">
                        <UserPlus className="size-3.5" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
