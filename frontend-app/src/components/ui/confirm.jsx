import { useEffect, useState } from 'react'
import { AlertTriangle, HelpCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

// Подтверждение действия в стиле сайта — вместо системного window.confirm()
// (серое окно браузера «Подтвердите действие на robops.ru»).
//
//   if (!(await confirmDialog({ title: 'Удалить роль?', description: '…', confirmText: 'Удалить', danger: true }))) return
//
// Возвращает Promise<boolean>: true — подтвердили, false — отмена/закрытие.
// Окно рисует <ConfirmHost />, смонтированный один раз в App.jsx.

let enqueue = null

/**
 * @param {string | { title: string, description?: import('react').ReactNode, confirmText?: string,
 *   cancelText?: string, danger?: boolean }} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog(opts) {
  const o = typeof opts === 'string' ? { title: opts } : opts
  return new Promise(resolve => {
    if (!enqueue) { resolve(window.confirm(o.title)); return } // хост не смонтирован — запасной вариант
    enqueue({ ...o, resolve })
  })
}

export function ConfirmHost() {
  const [queue, setQueue] = useState([])
  const current = queue[0]

  useEffect(() => {
    enqueue = item => setQueue(q => [...q, item])
    return () => { enqueue = null }
  }, [])

  const close = result => {
    current?.resolve(result)
    setQueue(q => q.slice(1))
  }

  if (!current) return null
  const { title, description, confirmText = 'Подтвердить', cancelText = 'Отмена', danger } = current
  const Icon = danger ? AlertTriangle : HelpCircle

  return (
    <Dialog open onOpenChange={o => !o && close(false)}>
      <DialogContent className="max-w-md" showClose={false}>
        <DialogHeader className="flex-row items-start gap-3.5 space-y-0">
          <span className={cn('grid size-10 shrink-0 place-items-center rounded-2xl', danger ? 'bg-destructive/10 text-destructive' : 'bg-brand-soft text-brand')}>
            <Icon className="size-5" />
          </span>
          <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
            <DialogTitle className="text-base leading-snug">{title}</DialogTitle>
            {description
              ? <DialogDescription className="whitespace-pre-line leading-relaxed">{description}</DialogDescription>
              : <DialogDescription className="sr-only">Подтверждение действия</DialogDescription>}
          </div>
        </DialogHeader>
        <DialogFooter className="mt-1">
          <Button variant="ghost" onClick={() => close(false)}>{cancelText}</Button>
          <Button autoFocus variant={danger ? 'destructive' : 'default'} onClick={() => close(true)}>{confirmText}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
