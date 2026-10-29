import { Checkbox } from '@/components/ui/checkbox'
import { TableRow, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getComplaintPhotos, photoUrl, thumbUrl } from './printServiceNote'
import { ImageOff, Pencil, Search } from 'lucide-react'

const fmtDate = iso => (iso ? new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '—')
const fmtTime = iso => (iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '')
const fmtDateTime = iso => (iso ? `${fmtDate(iso)} ${fmtTime(iso)}` : '—')

// Статус жалобы по результату поиска в WMS
export function complaintStatus(c) {
  if (c.lookupError) return { key: 'error', label: 'Ошибка поиска', cls: 'bg-warning/15 text-warning' }
  if (c.violator) return { key: 'found', label: 'Найден', cls: 'bg-success/15 text-success' }
  if (c.lookupDone) return { key: 'not_found', label: 'Не найден', cls: 'bg-destructive/10 text-destructive' }
  return { key: 'new', label: 'Не проверена', cls: 'bg-muted text-muted-foreground' }
}

function StatusChip({ c }) {
  const s = complaintStatus(c)
  return <span title={c.lookupError || undefined} className={cn('inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium', s.cls)}>{s.label}</span>
}

// Первое фото жалобы миниатюрой (+N, если фото несколько); нет миниатюры — полное фото
function PhotoThumb({ c, onPhotoOpen, size = 'size-14' }) {
  const names = getComplaintPhotos(c)
  if (!names.length) {
    return <div className={cn('flex shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground', size)} title="Нет фото"><ImageOff className="size-4" /></div>
  }
  return (
    <button type="button" className={cn('relative shrink-0 overflow-hidden rounded-xl border border-line', size)} onClick={() => onPhotoOpen(names.map(photoUrl), 0)} title="Открыть фото">
      <img src={thumbUrl(names[0])} alt="" loading="lazy" className="size-full object-cover"
        onError={e => { if (!e.currentTarget.dataset.full) { e.currentTarget.dataset.full = '1'; e.currentTarget.src = photoUrl(names[0]) } }} />
      {names.length > 1 && <span className="absolute bottom-0.5 right-0.5 rounded-md bg-black/60 px-1 text-[10px] font-semibold text-white">+{names.length - 1}</span>}
    </button>
  )
}

function Actions({ c, onLookup, onEdit, lookingUp }) {
  return (
    <div className="flex items-center justify-end gap-0.5">
      <Button size="icon" variant="ghost" className="size-8" disabled={lookingUp} title="Найти нарушителя в WMS" onClick={() => onLookup(c)}>
        <Search className={lookingUp ? 'size-4 animate-pulse text-primary' : 'size-4'} />
      </Button>
      <Button size="icon" variant="ghost" className="size-8" title="Изменить вручную" onClick={() => onEdit(c)}>
        <Pencil className="size-4" />
      </Button>
    </div>
  )
}

export function ComplaintRow({ complaint: c, selected, onToggle, onLookup, onEdit, onPhotoOpen, lookingUp }) {
  return (
    <TableRow data-state={selected ? 'selected' : undefined} className="align-top">
      <TableCell className="w-10 py-3"><Checkbox checked={selected} onCheckedChange={onToggle} /></TableCell>
      <TableCell className="w-16 py-2"><PhotoThumb c={c} onPhotoOpen={onPhotoOpen} /></TableCell>
      <TableCell className="py-3">
        <div className="text-sm font-medium tabular-nums">{fmtDate(c.createdAt)} <span className="text-muted-foreground">{fmtTime(c.createdAt)}</span></div>
        <div className="text-xs text-muted-foreground">{c.employeeName || '—'}</div>
      </TableCell>
      <TableCell className="py-3">
        <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold">{c.cell || '—'}</span>
        {c.handlingUnitBarcode && <div className="mt-1 font-mono text-[11px] text-muted-foreground" title="ЕО">ЕО {c.handlingUnitBarcode}</div>}
      </TableCell>
      <TableCell className="max-w-72 py-3">
        <div className="line-clamp-2 text-sm" title={c.productName || ''}>{c.productName || <span className="text-muted-foreground">товар не определён</span>}</div>
        <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{[c.nomenclatureCode, c.barcode].filter(Boolean).join(' · ') || '—'}</div>
      </TableCell>
      <TableCell className="py-3">
        {c.violator ? (
          <>
            <div className="text-sm font-medium">{c.violator}</div>
            <div className="text-xs text-muted-foreground">{[c.company, c.operationCompletedAt && `положил ${fmtDateTime(c.operationCompletedAt)}`].filter(Boolean).join(' · ')}</div>
          </>
        ) : <span className="text-sm text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="py-3"><StatusChip c={c} /></TableCell>
      <TableCell className="py-2"><Actions c={c} onLookup={onLookup} onEdit={onEdit} lookingUp={lookingUp} /></TableCell>
    </TableRow>
  )
}

// Телефон: та же жалоба карточкой
export function MobileComplaintCard({ complaint: c, selected, onToggle, onLookup, onEdit, onPhotoOpen, lookingUp }) {
  return (
    <div className={cn('flex gap-3 p-3', selected && 'bg-primary/5')}>
      <div className="flex flex-col items-center gap-2 pt-1">
        <Checkbox checked={selected} onCheckedChange={onToggle} />
      </div>
      <PhotoThumb c={c} onPhotoOpen={onPhotoOpen} size="size-16" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-start justify-between gap-2">
          <div className="line-clamp-2 text-sm font-medium">{c.productName || <span className="text-muted-foreground">товар не определён</span>}</div>
          <StatusChip c={c} />
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono font-semibold text-foreground">{c.cell || '—'}</span>
          <span>{fmtDateTime(c.createdAt)}</span>
          <span>· {c.employeeName || '—'}</span>
        </div>
        {c.violator && (
          <div className="text-xs"><span className="font-medium">{c.violator}</span>{c.company ? <span className="text-muted-foreground"> · {c.company}</span> : null}</div>
        )}
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] text-muted-foreground">{[c.nomenclatureCode, c.barcode].filter(Boolean).join(' · ')}</span>
          <Actions c={c} onLookup={onLookup} onEdit={onEdit} lookingUp={lookingUp} />
        </div>
      </div>
    </div>
  )
}
