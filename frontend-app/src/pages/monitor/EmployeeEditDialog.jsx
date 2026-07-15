import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

/**
 * Порт EmployeeEditModal оригинала — но только статус «на смене» по клику на
 * строку. Смену компании убрали по запросу: компания сотрудника — это
 * зона ответственности Настроек (вкладка «Сотрудники»), а не мониторинга
 * смены, здесь это было лишней (и рискованной) функцией.
 */
export function EmployeeEditDialog({ row, onOpenChange, onSave }) {
  const [onShift, setOnShift] = useState(row.isPresent)

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Сотрудник</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">ФИО</div>
            <div className="font-medium">{row.displayFio}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Компания</div>
            <div className="font-medium">{row.company === '—' ? '—' : row.company}</div>
          </div>
          <label className="flex items-center gap-2">
            <Checkbox checked={onShift} onCheckedChange={() => setOnShift(v => !v)} />
            <span className="font-medium">На смене</span>
            <span className="text-xs text-muted-foreground">(снять — «Нет на смене»)</span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button onClick={() => onSave({ onShift })}>Сохранить</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
