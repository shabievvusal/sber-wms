import { toast } from 'sonner'
import { AlertTriangle, UserPlus } from 'lucide-react'
import * as api from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { fmtHours, fmtNum, fmtPct, fmtTime, resolveAccount, STATUS_META } from './format'
import { PersonMenu } from './PersonMenu'

const th = 'h-8 px-2 text-[11px] whitespace-nowrap'
const td = 'px-2 py-1.5 text-[13px] whitespace-nowrap'
const num = `${td} text-right tabular-nums`

// readOnly — учётки из статистики без человека в акте (MotivationPage):
// записи в смене нет, меню по клику на имя предлагает внести в акт (onAdd).
// Иначе — люди смены: меню по клику меняет ФИО/учётку/роль или удаляет.
export function ShiftTable({ company, rows, accountIndex, onChanged, readOnly = false, onAdd }) {
  const totalHours = rows.reduce((s, r) => s + (r.hours || 0), 0)
  const zero = rows.filter(r => r.role === 'picker' && (r.hours || 0) === 0).length
  const under = rows.filter(r => r.status === 'under').length
  const over = rows.filter(r => r.status === 'over').length

  const update = async (row, patch, okMessage) => {
    try {
      await api.updateMotivationPerson(row.id, patch)
      if (okMessage) toast.success(okMessage)
      onChanged()
    } catch (err) {
      toast.error(err.message)
    }
  }

  const changeAccount = (row, text) => {
    const next = resolveAccount(text, accountIndex)
    if (!next.matched) toast.warning(`«${next.executorName}» нет в справочнике — будет искаться по имени в WMS`)
    return update(row, { executorId: next.executorId, executorName: next.executorName })
  }

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
              <UserPlus className="size-3.5" /> Внести всех в акт
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
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(r => {
              const [label, variant] = STATUS_META[r.status] || [r.status, 'outline']
              const hasStats = r.storageTasks + r.kdkTasks > 0
              const hasAccount = r.executorId || r.executorName
              return (
                <TableRow key={readOnly ? r.executorId : r.id}>
                  <TableCell className={td}>
                    {readOnly ? (
                      onAdd
                        ? <PersonMenu row={r} onAdd={extra => onAdd([{ ...r, ...extra }])} />
                        : <span className="font-medium">{r.fio}</span>
                    ) : (
                      <PersonMenu
                        row={r} inShift
                        onRename={fio => update(r, { fio })}
                        onChangeAccount={text => changeAccount(r, text)}
                        onSetRole={role => update(r, { role })}
                        onDelete={() => remove(r)}
                      />
                    )}
                  </TableCell>
                  {readOnly ? <TableCell className={`${td} text-muted-foreground`}>{r.executorId}</TableCell> : <>
                    <TableCell className={`${td} text-xs`}>{r.role === 'other' ? 'Без нормы' : 'Комплект.'}</TableCell>
                    <TableCell className={td}>
                      {hasAccount
                        ? <span>{r.executorName || r.executorId}{r.executorId && <span className="text-muted-foreground"> · {r.executorId}</span>}</span>
                        : <span className="text-destructive">не указана</span>}
                    </TableCell>
                    <TableCell className={`${td} ${r.late ? 'font-semibold text-destructive' : ''}`}>
                      {r.receivedAt ? fmtTime(r.receivedAt) : hasAccount ? <span className="text-xs text-muted-foreground">из статистики</span> : '—'}
                    </TableCell>
                  </>}
                  <TableCell className={num}>{hasStats ? fmtNum(r.storageTasks) : '—'}</TableCell>
                  <TableCell className={num}>{hasStats ? fmtNum(r.kdkTasks) : '—'}</TableCell>
                  <TableCell className={num}>{hasStats ? fmtNum(r.storageWeightKg) : '—'}</TableCell>
                  <TableCell className={num}>
                    {hasStats ? fmtNum(r.kdkWeightKg) : '—'}
                    {r.missingWeightItems > 0 && (
                      <span title={`Отборов без веса в справочнике: ${r.missingWeightItems}. Их вес оценён по среднему весу отбора (${fmtNum(r.estimatedWeightKg)} кг) и уже входит в вес. Загрузите ВГХ в Настройках, чтобы вес был точным.`}>
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
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
