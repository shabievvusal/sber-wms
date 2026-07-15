import { useEffect, useState } from 'react'
import * as api from '@/lib/api'
import { Input } from '@/components/ui/input'
import { SettingCard } from './SettingCard'
import { FileText } from 'lucide-react'

const LS_COMPANY_FULL_NAMES = 'sz_company_full_names'
const LS_FINE_AMOUNT = 'sz_fine_amount'

export function DocsCard() {
  const [companies, setCompanies] = useState([])
  const [fullNames, setFullNames] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_COMPANY_FULL_NAMES) || '{}') } catch { return {} }
  })
  const [fineAmount, setFineAmount] = useState(() => {
    try { const v = localStorage.getItem(LS_FINE_AMOUNT); return v !== null ? v : '' } catch { return '' }
  })

  useEffect(() => {
    api.getEmployees().then(d => setCompanies(d.companies || [])).catch(() => setCompanies([]))
  }, [])

  const handleChange = (company, value) => {
    setFullNames(prev => {
      const updated = { ...prev, [company]: value }
      try { localStorage.setItem(LS_COMPANY_FULL_NAMES, JSON.stringify(updated)) } catch { /* ignore */ }
      return updated
    })
  }

  const handleFineChange = e => {
    const val = e.target.value
    setFineAmount(val)
    try { localStorage.setItem(LS_FINE_AMOUNT, val) } catch { /* ignore */ }
  }

  return (
    <SettingCard icon={FileText} title="Полные названия компаний" subtitle="Используются при печати служебных записок (СЗ) и в отчётах по нарушениям">
      <label className="mb-5 block max-w-[200px] space-y-1.5 text-sm">
        <span className="font-medium">Сумма штрафа за одну ошибку, руб.</span>
        <Input type="number" min="0" step="1" value={fineAmount} onChange={handleFineChange} placeholder="0" />
      </label>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="w-2/5 p-2 text-left font-medium">Краткое название</th>
              <th className="p-2 text-left font-medium">Полное юридическое название</th>
            </tr>
          </thead>
          <tbody>
            {companies.map(company => (
              <tr key={company} className="border-b last:border-0">
                <td className="p-2">{company}</td>
                <td className="p-1.5">
                  <Input className="h-8" value={fullNames[company] || ''} onChange={e => handleChange(company, e.target.value)} placeholder='ООО "Название компании"' />
                </td>
              </tr>
            ))}
            {companies.length === 0 && (
              <tr><td colSpan={2} className="p-6 text-center text-muted-foreground">Загрузите сотрудников — появятся компании</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </SettingCard>
  )
}
