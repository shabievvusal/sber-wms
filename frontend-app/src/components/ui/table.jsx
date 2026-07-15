import * as React from 'react'
import { cn } from '@/lib/utils'

function Table({ className, ...props }) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table data-slot="table" className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  )
}
function TableHeader({ className, ...props }) {
  return <thead data-slot="table-header" className={cn('[&_tr]:border-b sticky top-0 z-10 bg-card', className)} {...props} />
}
function TableBody({ className, ...props }) {
  return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />
}
function TableRow({ className, ...props }) {
  return (
    <tr
      data-slot="table-row"
      className={cn('border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted', className)}
      {...props}
    />
  )
}
function TableHead({ className, ...props }) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'h-9 px-3 text-left align-middle font-medium text-muted-foreground whitespace-nowrap select-none',
        className
      )}
      {...props}
    />
  )
}
function TableCell({ className, ...props }) {
  return <td data-slot="table-cell" className={cn('p-3 align-middle whitespace-nowrap', className)} {...props} />
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell }
