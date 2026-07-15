import { useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Download } from 'lucide-react'

const LS_COMPANY_FULL_NAMES = 'sz_company_full_names'
const LS_FINE_AMOUNT = 'sz_fine_amount'

function getCompanyFullNames() {
  try { return JSON.parse(localStorage.getItem(LS_COMPANY_FULL_NAMES) || '{}') } catch { return {} }
}
function getFineAmount() {
  try { const v = localStorage.getItem(LS_FINE_AMOUNT); return v ? Number(v) : 0 } catch { return 0 }
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}
function todayStr() { return new Date().toISOString().slice(0, 10) }

export function ExportReportDialog({ onOpenChange }) {
  const [from, setFrom] = useState(todayStr())
  const [to, setTo] = useState(todayStr())
  const [exporting, setExporting] = useState(null) // null | 1 | 2

  const handleExport = async reportNum => {
    setExporting(reportNum)
    try {
      const blob = await api.exportConsolidationReport(reportNum, {
        dateFrom: from, dateTo: to, companyFullNames: getCompanyFullNames(), fineAmount: getFineAmount(),
      })
      const suffix = `${from}_${to}`
      downloadBlob(blob, reportNum === 1 ? `Нарушения_${suffix}.xlsx` : `Сводка_нарушений_${suffix}.xlsx`)
      toast.success('Отчёт сформирован')
    } catch (err) {
      toast.error('Ошибка экспорта: ' + err.message)
    } finally {
      setExporting(null)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Выгрузить отчёт по нарушениям</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Период:</span>
            <DatePicker value={from} onChange={e => setFrom(e.target.value)} className="flex-1" />
            <span className="text-muted-foreground">—</span>
            <DatePicker value={to} onChange={e => setTo(e.target.value)} className="flex-1" />
          </div>
          <p className="text-xs text-muted-foreground">
            Учитываются только нарушения с найденным нарушителем.<br />
            Официальные названия и сумма штрафа берутся из Настройки → Документы.
          </p>
          <div className="flex flex-col gap-2">
            <Button disabled={!!exporting || !from || !to} onClick={() => handleExport(1)}>
              <Download className="size-3.5" /> {exporting === 1 ? 'Формирование...' : 'Отчёт 1 — Детальный (нарушения)'}
            </Button>
            <Button variant="secondary" disabled={!!exporting || !from || !to} onClick={() => handleExport(2)}>
              <Download className="size-3.5" /> {exporting === 2 ? 'Формирование...' : 'Отчёт 2 — Сводный (штрафы + анализ)'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
