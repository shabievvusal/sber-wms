import { useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { DateRangePicker } from '@/components/ui/date-picker'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Download, Trash2, Loader2 } from 'lucide-react'

function todayIso() { return new Date().toISOString().slice(0, 10) }
function monthStartIso() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

export default function ReportModal({ open, onOpenChange }) {
  const [dateFrom, setDateFrom] = useState(monthStartIso())
  const [dateTo, setDateTo] = useState(todayIso())
  const [downloading, setDownloading] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const handleDownload = async () => {
    if (!dateFrom || !dateTo) { toast.error('Выберите период'); return }
    setDownloading(true)
    try {
      const r = await fetch(`/api/shipments/report?dateFrom=${dateFrom}&dateTo=${dateTo}`, { credentials: 'include' })
      if (!r.ok) { const e = await r.json(); throw new Error(e.error || 'Ошибка') }
      const blob = await r.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'Отчет по РК, ящикам, ТЧ.xlsx'
      a.click()
      URL.revokeObjectURL(a.href)
      toast.success('Отчёт скачан')
    } catch (err) { toast.error('Ошибка: ' + err.message) }
    finally { setDownloading(false) }
  }

  const handleDelete = async () => {
    if (!dateFrom || !dateTo) { toast.error('Выберите период'); return }
    if (!confirm(`Удалить все данные за период ${dateFrom} — ${dateTo}?\nЭто действие нельзя отменить.`)) return
    setDeleting(true)
    try {
      const res = await api.deleteRkRoutesByDateRange(dateFrom, dateTo)
      if (!res.ok) throw new Error(res.error || 'Ошибка удаления')
      toast.success(`Удалено маршрутов: ${res.deleted ?? ''}`)
    } catch (err) { toast.error('Ошибка: ' + err.message) }
    finally { setDeleting(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Отчёт за период</DialogTitle>
          <DialogDescription>По РК, паллетам, ящикам и термочехлам</DialogDescription>
        </DialogHeader>

        <DateRangePicker from={dateFrom} to={dateTo} onChange={({ from, to }) => { setDateFrom(from); setDateTo(to) }} className="w-full" />

        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-muted-foreground">
          Удаление данных за период необратимо — используйте только для очистки тестовых/ошибочных записей.
        </div>

        <DialogFooter className="sm:justify-between">
          <Button variant="destructive" size="sm" disabled={deleting} onClick={handleDelete}>
            {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />} Удалить за период
          </Button>
          <Button size="sm" disabled={downloading} onClick={handleDownload}>
            {downloading ? <Loader2 className="animate-spin" /> : <Download />} Скачать .xlsx
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
