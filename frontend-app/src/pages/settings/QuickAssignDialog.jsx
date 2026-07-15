import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

/** Замена window.prompt из оригинала — назначить компанию сотруднику в один клик. */
export function QuickAssignDialog({ fio, companies, onSave, onOpenChange }) {
  const [company, setCompany] = useState('')

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Назначить компанию</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <div className="text-xs text-muted-foreground">Сотрудник</div>
            <div className="font-medium">{fio}</div>
          </div>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Компания</span>
            <Input
              autoFocus
              list="quick-assign-companies"
              value={company}
              onChange={e => setCompany(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && company.trim() && onSave(company.trim())}
              placeholder="Введите или выберите..."
            />
            <datalist id="quick-assign-companies">
              {companies.map(c => <option key={c} value={c} />)}
            </datalist>
          </label>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button disabled={!company.trim()} onClick={() => onSave(company.trim())}>Сохранить</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
