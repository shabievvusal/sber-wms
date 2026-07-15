import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

// Выезжающая справа панель (EoPanel/ExecutorsPanel в SupplyDetailPage) — тот же
// Dialog-примитив, что и components/ui/dialog.jsx, но фиксированной ширины и
// на всю высоту экрана вместо центрированного окна.
function Sheet(props) { return <DialogPrimitive.Root data-slot="sheet" {...props} /> }
function SheetTrigger(props) { return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} /> }
function SheetPortal(props) { return <DialogPrimitive.Portal data-slot="sheet-portal" {...props} /> }
function SheetClose(props) { return <DialogPrimitive.Close data-slot="sheet-close" {...props} /> }

function SheetOverlay({ className, ...props }) {
  return (
    <DialogPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-black/50',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className
      )}
      {...props}
    />
  )
}

function SheetContent({ className, children, showClose = true, ...props }) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-sm flex-col gap-0 border-l bg-card shadow-lg sm:max-w-md',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
          className
        )}
        {...props}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close className="absolute top-4 right-4 rounded-sm opacity-70 outline-none transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring">
            <X className="size-4" />
            <span className="sr-only">Закрыть</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }) {
  return <div data-slot="sheet-header" className={cn('flex flex-col gap-1 border-b p-4', className)} {...props} />
}
function SheetTitle({ className, ...props }) {
  return <DialogPrimitive.Title data-slot="sheet-title" className={cn('font-semibold', className)} {...props} />
}
function SheetDescription({ className, ...props }) {
  return <DialogPrimitive.Description data-slot="sheet-description" className={cn('text-sm text-muted-foreground', className)} {...props} />
}
function SheetBody({ className, ...props }) {
  return <div data-slot="sheet-body" className={cn('flex-1 overflow-y-auto p-4', className)} {...props} />
}

export { Sheet, SheetTrigger, SheetPortal, SheetClose, SheetOverlay, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetBody }
