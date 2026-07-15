import { useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { TableRow, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { getComplaintPhotos, photoUrl } from './printServiceNote'
import { Search, Pencil, ImageOff, AlertTriangle } from 'lucide-react'

function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function ComplaintRow({ complaint: c, selected, onToggle, onLookup, onEdit, onPhotoOpen, lookingUp }) {
  const [expanded, setExpanded] = useState(false)
  const photos = getComplaintPhotos(c).map(photoUrl)
  const hasPhotos = photos.length > 0

  return (
    <>
      <TableRow
        className={hasPhotos ? 'cursor-pointer' : ''}
        onClick={e => hasPhotos && !e.target.closest('button, [role="checkbox"]') && setExpanded(v => !v)}
      >
        <TableCell onClick={e => e.stopPropagation()}>
          <Checkbox checked={selected} onCheckedChange={onToggle} />
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">{fmtDateTime(c.createdAt)}</TableCell>
        <TableCell>{c.employeeName || '—'}</TableCell>
        <TableCell className="font-mono text-xs">{c.cell || '—'}</TableCell>
        <TableCell className="font-mono text-xs">{c.barcode || '—'}</TableCell>
        <TableCell className="font-mono text-xs">{c.nomenclatureCode || '—'}</TableCell>
        <TableCell className="max-w-48 truncate" title={c.productName}>{c.productName || '—'}</TableCell>
        <TableCell>
          {c.violator ? (
            <span>{c.violator}</span>
          ) : (
            <span className="text-muted-foreground">Не найден</span>
          )}
          {c.lookupError && (
            <Badge variant="warning" className="ml-1.5" title={c.lookupError}>
              <AlertTriangle className="size-3" />
            </Badge>
          )}
        </TableCell>
        <TableCell className="text-muted-foreground">{c.company || '—'}</TableCell>
        <TableCell className="text-xs text-muted-foreground">{fmtDateTime(c.operationCompletedAt)}</TableCell>
        <TableCell onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-1">
            <Button size="icon" variant="ghost" disabled={lookingUp} title="Найти нарушителя" onClick={() => onLookup(c)}>
              <Search className={lookingUp ? 'size-4 animate-pulse' : 'size-4'} />
            </Button>
            <Button size="icon" variant="ghost" title="Изменить вручную" onClick={() => onEdit(c)}>
              <Pencil className="size-4" />
            </Button>
          </div>
        </TableCell>
      </TableRow>

      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={11} className="bg-muted/20 py-3">
            <div className="flex flex-wrap gap-2">
              {photos.length ? photos.map((url, i) => (
                <button key={i} className="overflow-hidden rounded-md border" onClick={() => onPhotoOpen(photos, i)}>
                  <img src={url} alt="" className="h-20 w-28 object-cover" />
                </button>
              )) : (
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground"><ImageOff className="size-4" /> Нет фото</div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

// Мобильная карточка — та же строка + разворот фото по тапу, что и в
// ComplaintRow, просто вертикальная раскладка вместо строки на 11 колонок.
export function MobileComplaintCard({ complaint: c, selected, onToggle, onLookup, onEdit, onPhotoOpen, lookingUp }) {
  const [expanded, setExpanded] = useState(false)
  const photos = getComplaintPhotos(c).map(photoUrl)
  const hasPhotos = photos.length > 0

  return (
    <div className="p-3">
      <div
        className={hasPhotos ? 'flex cursor-pointer items-start justify-between gap-2' : 'flex items-start justify-between gap-2'}
        onClick={e => hasPhotos && !e.target.closest('button, [role="checkbox"]') && setExpanded(v => !v)}
      >
        <div className="flex min-w-0 items-start gap-2">
          <span onClick={e => e.stopPropagation()}>
            <Checkbox checked={selected} onCheckedChange={onToggle} />
          </span>
          <div className="min-w-0">
            <div className="truncate font-medium" title={c.productName}>{c.productName || '—'}</div>
            <div className="text-xs text-muted-foreground">{fmtDateTime(c.createdAt)} · {c.employeeName || '—'}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1" onClick={e => e.stopPropagation()}>
          <Button size="icon" variant="ghost" disabled={lookingUp} title="Найти нарушителя" onClick={() => onLookup(c)}>
            <Search className={lookingUp ? 'size-4 animate-pulse' : 'size-4'} />
          </Button>
          <Button size="icon" variant="ghost" title="Изменить вручную" onClick={() => onEdit(c)}>
            <Pencil className="size-4" />
          </Button>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>Место: <span className="font-mono text-xs text-foreground">{c.cell || '—'}</span></span>
        <span>ШК: <span className="font-mono text-xs text-foreground">{c.barcode || '—'}</span></span>
        <span>Артикул: <span className="font-mono text-xs text-foreground">{c.nomenclatureCode || '—'}</span></span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="text-muted-foreground">Нарушитель:{' '}
          {c.violator ? <span className="text-foreground">{c.violator}</span> : <span>Не найден</span>}
          {c.lookupError && (
            <Badge variant="warning" className="ml-1.5" title={c.lookupError}>
              <AlertTriangle className="size-3" />
            </Badge>
          )}
        </span>
        <span className="text-muted-foreground">Компания: <span className="text-foreground">{c.company || '—'}</span></span>
        <span className="text-muted-foreground">Нарушение: <span className="text-foreground">{fmtDateTime(c.operationCompletedAt)}</span></span>
      </div>

      {expanded && (
        <div className="mt-2 flex flex-wrap gap-2 border-t pt-2">
          {photos.length ? photos.map((url, i) => (
            <button key={i} className="overflow-hidden rounded-md border" onClick={() => onPhotoOpen(photos, i)}>
              <img src={url} alt="" className="h-20 w-28 object-cover" />
            </button>
          )) : (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground"><ImageOff className="size-4" /> Нет фото</div>
          )}
        </div>
      )}
    </div>
  )
}
