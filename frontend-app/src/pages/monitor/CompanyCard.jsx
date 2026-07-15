import { cn } from '@/lib/utils'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { TaskTypeBadge } from './TaskTypeBadge'
import { formatDuration, shortFio } from './format'
import { ChevronUp, ChevronDown } from 'lucide-react'

function EmployeeRow({ r, onClick }) {
  const szVal = r.sz != null && r.sz > 0 ? String(r.sz) : '—'
  const lastTaskStr = r.lastTaskMs != null ? formatDuration(r.lastTaskMs) : '—'

  if (r.inWorkByTask) {
    const taskStr = r.taskDurationMs ? formatDuration(r.taskDurationMs) : null
    return (
      <TableRow className="cursor-pointer" onClick={() => onClick(r)} title="Нажмите, чтобы изменить компанию и статус на смене">
        <TableCell className="max-w-32 truncate font-medium" title={r.displayFio}>{shortFio(r.displayFio)}</TableCell>
        <TableCell><TaskTypeBadge type={r.taskType} /></TableCell>
        <TableCell><span className="inline-flex items-center gap-1.5"><span className="size-2 shrink-0 rounded-full bg-success" /> в работе</span></TableCell>
        <TableCell className="text-xs">
          <span className="text-success">{lastTaskStr} назад</span>
          {r.isActive && taskStr && <span className="ml-1 text-muted-foreground">(задача {taskStr})</span>}
        </TableCell>
        <TableCell className="text-right">{szVal}</TableCell>
      </TableRow>
    )
  }

  const sinceStr = r.lastTaskMs != null ? `${lastTaskStr} назад` : 'нет данных'
  return (
    <TableRow className="cursor-pointer" onClick={() => onClick(r)} title="Нажмите, чтобы изменить компанию и статус на смене">
      <TableCell className="max-w-32 truncate font-medium" title={r.displayFio}>{shortFio(r.displayFio)}</TableCell>
      <TableCell><TaskTypeBadge type={r.taskType} /></TableCell>
      <TableCell><span className="inline-flex items-center gap-1.5"><span className="size-2 shrink-0 rounded-full bg-destructive" /> не в работе</span></TableCell>
      <TableCell className="text-xs text-muted-foreground">{sinceStr}</TableCell>
      <TableCell className="text-right">{szVal}</TableCell>
    </TableRow>
  )
}

// Компактная строка на телефоне — та же информация, что и в EmployeeRow, но в
// одну карточку вместо 5 колонок (в двух колонках CompanyCard'а это всё равно
// не влезло бы без горизонтального скролла внутри развёрнутой карточки).
function EmployeeMobileRow({ r, onClick }) {
  const szVal = r.sz != null && r.sz > 0 ? String(r.sz) : '—'
  const lastTaskStr = r.lastTaskMs != null ? formatDuration(r.lastTaskMs) : '—'
  const sinceStr = r.inWorkByTask
    ? <span className="text-success">{lastTaskStr} назад{r.isActive && r.taskDurationMs ? ` (задача ${formatDuration(r.taskDurationMs)})` : ''}</span>
    : <span className="text-muted-foreground">{r.lastTaskMs != null ? `${lastTaskStr} назад` : 'нет данных'}</span>

  return (
    <div className="flex items-center justify-between gap-2 p-2.5 text-sm" onClick={() => onClick(r)}>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={cn('size-2 shrink-0 rounded-full', r.inWorkByTask ? 'bg-success' : 'bg-destructive')} />
          <span className="truncate font-medium" title={r.displayFio}>{shortFio(r.displayFio)}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <TaskTypeBadge type={r.taskType} />
          {sinceStr}
        </div>
      </div>
      <span className="shrink-0 text-right font-medium tabular-nums">{szVal}</span>
    </div>
  )
}

function EmpTable({ rows, onRowClick, emptyText }) {
  if (!rows.length) return <div className="p-3 text-center text-sm text-muted-foreground">{emptyText}</div>
  return (
    <>
      <div className="divide-y md:hidden">
        {rows.map(r => <EmployeeMobileRow key={r.executorId} r={r} onClick={onRowClick} />)}
      </div>
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ФИО</TableHead>
              <TableHead>Тип задачи</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead>В задаче / Простой</TableHead>
              <TableHead className="text-right">СЗ</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(r => <EmployeeRow key={r.executorId} r={r} onClick={onRowClick} />)}
          </TableBody>
        </Table>
      </div>
    </>
  )
}

export function CompanyCard({ g, isExpanded, onToggle, onRowClick }) {
  const total = g.active + g.inactive
  const activeRows = g.rows.filter(r => r.inWorkByTask)
  const inactiveRows = g.rows.filter(r => !r.inWorkByTask)

  return (
    <div className={`rounded-lg border-l-4 border bg-card ${g.inactive === 0 ? 'border-l-success' : 'border-l-warning'}`}>
      <button className="flex w-full flex-wrap items-center gap-3 p-4 text-left" onClick={onToggle}>
        <span className="font-semibold">{g.company}</span>
        <span className="text-sm text-muted-foreground">{total} чел.</span>
        <div className="ml-auto flex items-center gap-2">
          <Badge variant="success">{g.active} в работе</Badge>
          {g.inactive > 0 && <Badge variant="warning">{g.inactive} не работают</Badge>}
          {isExpanded ? <ChevronUp className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />}
        </div>
      </button>

      {isExpanded && (
        <div className="grid grid-cols-1 gap-4 border-t p-4 md:grid-cols-2">
          <div className="overflow-hidden rounded-md border">
            <div className="border-b bg-success/10 px-3 py-1.5 text-xs font-medium text-success">В работе ({activeRows.length})</div>
            <EmpTable rows={activeRows} onRowClick={onRowClick} emptyText="Нет активных" />
          </div>
          <div className="overflow-hidden rounded-md border">
            <div className="border-b bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive">Не работают ({inactiveRows.length})</div>
            <EmpTable rows={inactiveRows} onRowClick={onRowClick} emptyText="Все в работе" />
          </div>
        </div>
      )}
    </div>
  )
}
