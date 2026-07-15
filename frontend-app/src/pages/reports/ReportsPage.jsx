import { useState } from 'react'
import { Button } from '@/components/ui/button'
import HourlyReport from './HourlyReport'

// Тонкая обёртка-вкладка, как в оригинале — сейчас в проекте только один
// отчёт («Отчёт каждый час»), вкладочная структура сохранена как задел под
// будущие отчёты, не выдумана заново.
const REPORT_TABS = [
  { key: 'hourly', label: 'Отчёт каждый час' },
]

export default function ReportsPage() {
  const [activeTab, setActiveTab] = useState('hourly')

  return (
    <div className="mx-auto w-full max-w-[1000px] space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Отчёты</h1>
      </div>

      <div className="flex items-center gap-1.5 rounded-md border bg-muted/30 p-1">
        {REPORT_TABS.map(t => (
          <Button key={t.key} size="sm" variant={activeTab === t.key ? 'default' : 'ghost'} onClick={() => setActiveTab(t.key)}>
            {t.label}
          </Button>
        ))}
      </div>

      {activeTab === 'hourly' && <HourlyReport />}
    </div>
  )
}
