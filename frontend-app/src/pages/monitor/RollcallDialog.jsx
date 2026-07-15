import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { shortFio } from './format'
import { ClipboardList } from 'lucide-react'

/**
 * Порт RollcallModal оригинала. Упрощение (см. PLAN.md): оригинал строит
 * объединение {зарегистрированные сотрудники} ∪ {люди из живого снимка} ∪
 * {уже отмеченные в перекличке} с дедупом по «первым двум словам ФИО» —
 * нужно только для реальных разночтений написания имени между разными
 * системами. Здесь связка везде по executorId — ни normalizeFio, ни
 * fio-fallback, ни alias-склейки нет и не должно быть (см. PLAN.md).
 */
export function RollcallDialog({ employees, present, onOpenChange, onSave }) {
  const [checks, setChecks] = useState(() => new Set(present))

  // Без executorId сотрудника нельзя однозначно связать с переклич./живым
  // снимком (см. PLAN.md — фолбэка по ФИО больше нет), поэтому такие записи
  // сюда не попадают — их сначала нужно привязать к UUID в Настройках.
  const linkedEmployees = employees.filter(e => e.executorId)

  const groups = new Map()
  for (const e of linkedEmployees) {
    if (!groups.has(e.company)) groups.set(e.company, [])
    groups.get(e.company).push(e)
  }
  const sortedCompanies = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'ru'))

  const toggle = executorId => setChecks(prev => {
    const next = new Set(prev)
    next.has(executorId) ? next.delete(executorId) : next.add(executorId)
    return next
  })
  const setGroup = (company, val) => setChecks(prev => {
    const next = new Set(prev)
    groups.get(company).forEach(e => val ? next.add(e.executorId) : next.delete(e.executorId))
    return next
  })
  const setAll = val => setChecks(val ? new Set(linkedEmployees.map(e => e.executorId)) : new Set())

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ClipboardList className="size-4" /> Перекличка — кто на смене</DialogTitle>
        </DialogHeader>

        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setAll(true)}>Все</Button>
          <Button size="sm" variant="outline" onClick={() => setAll(false)}>Никого</Button>
        </div>

        <div className="space-y-4">
          {sortedCompanies.length === 0 ? (
            <p className="text-sm text-muted-foreground">Список сотрудников пуст. Добавьте сотрудников в настройках.</p>
          ) : sortedCompanies.map(company => (
            <div key={company} className="space-y-1.5">
              <div className="flex items-center gap-2 border-b pb-1.5">
                <span className="flex-1 text-sm font-medium">{company}</span>
                <Button size="sm" variant="ghost" onClick={() => setGroup(company, true)}>Все</Button>
                <Button size="sm" variant="ghost" onClick={() => setGroup(company, false)}>Никого</Button>
              </div>
              <div className="space-y-1">
                {[...groups.get(company)].sort((a, b) => a.fio.localeCompare(b.fio, 'ru')).map(e => (
                  <label key={e.executorId} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted">
                    <Checkbox checked={checks.has(e.executorId)} onCheckedChange={() => toggle(e.executorId)} />
                    <span title={e.fio}>{shortFio(e.fio)}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button onClick={() => onSave([...checks])}>Сохранить</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
