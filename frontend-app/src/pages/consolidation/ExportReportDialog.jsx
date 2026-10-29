import { whKey } from '@/lib/warehouse'
import { useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { DateRangePicker } from '@/components/ui/date-picker'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FileSpreadsheet, Loader2 } from 'lucide-react'

const LS_COMPANY_FULL_NAMES = 'sz_company_full_names'
const LS_FINE_AMOUNT = 'sz_fine_amount'

function getCompanyFullNames() {
  try { return JSON.parse(localStorage.getItem(whKey(LS_COMPANY_FULL_NAMES)) || '{}') } catch { return {} }
}
function getFineAmount() {
  try { const v = localStorage.getItem(whKey(LS_FINE_AMOUNT)); return v ? Number(v) : 0 } catch { return 0 }
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}
function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const REPORTS = [
  { num: 1, title: 'Детальный', desc: 'Каждое нарушение: дата, ячейка, товар, нарушитель, компания, ссылка на фото' },
  { num: 2, title: 'Сводный', desc: 'По компаниям: число нарушений, штрафы и анализ по дням с выходом сотрудников' },
]

// defaultFrom/defaultTo — период, выбранный на странице
export function ExportReportDialog({ onOpenChange, defaultFrom, defaultTo }) {
  const [range, setRange] = useState({ from: defaultFrom || todayStr(), to: defaultTo || todayStr() })
  const from = range.from, to = range.to || range.from
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
          <DialogTitle>Отчёт для подрядчиков</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <DateRangePicker className="h-9 w-full" from={range.from} to={range.to} onChange={r => setRange(r)} placeholder="Выберите период" />
          <div className="space-y-2">
            {REPORTS.map(r => (
              <button key={r.num} type="button" disabled={!!exporting || !from} onClick={() => handleExport(r.num)}
                className="flex w-full items-start gap-3 rounded-2xl border border-line bg-card p-3 text-left transition-colors hover:border-primary/50 hover:bg-muted/40 disabled:opacity-60">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  {exporting === r.num ? <Loader2 className="size-4 animate-spin" /> : <FileSpreadsheet className="size-4" />}
                </div>
                <div>
                  <div className="text-sm font-semibold">{r.title}</div>
                  <div className="text-xs text-muted-foreground">{r.desc}</div>
                </div>
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            В отчёт попадают только нарушения с найденным нарушителем. Официальные названия компаний и сумма штрафа — в Настройки → Документы.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
