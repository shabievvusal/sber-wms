import { whKey } from '@/lib/warehouse'
import { useEffect, useState } from 'react'
import * as api from '@/lib/api'
import { Input } from '@/components/ui/input'
import { EditableCell } from '@/components/ui/editable-cell'
import { SettingCard } from './SettingCard'
import { Field, theadCls, thCls, trCls, tableWrapCls } from './ui'
import { Building2, FileText } from 'lucide-react'
import { DEFAULT_ACT_CONSTANTS, loadActConstants, saveActConstants } from '../shift-plan/actConstants'

const LS_COMPANY_FULL_NAMES = 'sz_company_full_names'
const LS_FINE_AMOUNT = 'sz_fine_amount'

const ACT_FIELDS = [
  { key: 'customerName', label: 'Заказчик' },
  { key: 'warehouseAddress', label: 'Адрес склада' },
  { key: 'warehouseType', label: 'Тип склада' },
  { key: 'warehouseCategory', label: 'Категория склада' },
]

const AutoSaveNote = () => <span className="text-xs text-muted-foreground">Сохраняется автоматически на этом устройстве</span>

/** Штраф для служебных записок и реквизиты для акта учёта времени (Мотивация). */
export function DocsCard() {
  const [fineAmount, setFineAmount] = useState(() => {
    try { const v = localStorage.getItem(whKey(LS_FINE_AMOUNT)); return v !== null ? v : '' } catch { return '' }
  })
  const [actConstants, setActConstants] = useState(() => loadActConstants())

  const handleFineChange = e => {
    const val = e.target.value
    setFineAmount(val)
    try { localStorage.setItem(whKey(LS_FINE_AMOUNT), val) } catch { /* ignore */ }
  }

  const handleActConstantChange = (key, value) => {
    setActConstants(prev => {
      const updated = { ...prev, [key]: value }
      saveActConstants(updated)
      return updated
    })
  }

  return (
    <>
      <SettingCard icon={FileText} title="Документы" subtitle="Штраф в служебных записках и реквизиты акта учёта времени" actions={<AutoSaveNote />}>
        <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
          <Field label="Штраф за одну ошибку" hint="Для служебных записок по нарушениям">
            <div className="relative">
              <Input type="number" min="0" step="1" className="pr-10" value={fineAmount} onChange={handleFineChange} placeholder="0" />
              <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-muted-foreground">₽</span>
            </div>
          </Field>
          <div className="space-y-3">
            <div className="text-sm font-medium">Реквизиты акта учёта времени</div>
            <div className="grid gap-3 sm:grid-cols-2">
              {ACT_FIELDS.map(({ key, label }) => (
                <label key={key} className="block space-y-1">
                  <span className="text-xs text-muted-foreground">{label}</span>
                  <Input
                    value={actConstants[key] ?? ''}
                    placeholder={DEFAULT_ACT_CONSTANTS[key]}
                    onChange={e => handleActConstantChange(key, e.target.value)}
                  />
                </label>
              ))}
            </div>
          </div>
        </div>
      </SettingCard>
      <CompanyFullNamesCard />
    </>
  )
}

/** Полные юридические названия компаний — для печати СЗ и отчётов по нарушениям. */
function CompanyFullNamesCard() {
  const [companies, setCompanies] = useState([])
  const [fullNames, setFullNames] = useState(() => {
    try { return JSON.parse(localStorage.getItem(whKey(LS_COMPANY_FULL_NAMES)) || '{}') } catch { return {} }
  })

  useEffect(() => {
    api.getEmployees().then(d => setCompanies(d.companies || [])).catch(() => setCompanies([]))
  }, [])

  const handleChange = (company, value) => {
    setFullNames(prev => {
      const updated = { ...prev, [company]: value.trim() }
      try { localStorage.setItem(whKey(LS_COMPANY_FULL_NAMES), JSON.stringify(updated)) } catch { /* ignore */ }
      return updated
    })
  }

  const filled = companies.filter(c => fullNames[c]).length

  return (
    <SettingCard
      icon={Building2}
      title="Полные названия компаний"
      subtitle={companies.length ? `Заполнено ${filled} из ${companies.length} · для печати служебных записок и отчётов` : 'Для печати служебных записок и отчётов по нарушениям'}
      actions={<AutoSaveNote />}
    >
      <div className={tableWrapCls}>
        <table className="w-full table-fixed text-sm">
          <colgroup><col className="w-[34%]" /><col /></colgroup>
          <thead className={theadCls}>
            <tr className="border-b border-line">
              <th className={thCls}>Компания</th>
              <th className={thCls}>Полное юридическое название</th>
            </tr>
          </thead>
          <tbody>
            {companies.map(company => (
              <tr key={company} className={trCls}>
                <td className="truncate px-3 py-1.5 font-medium" title={company}>{company}</td>
                <td className="px-1 py-1.5">
                  <EditableCell
                    value={fullNames[company] || ''}
                    placeholder='Например: ООО "Название компании"'
                    onCommit={v => handleChange(company, v)}
                  />
                </td>
              </tr>
            ))}
            {companies.length === 0 && (
              <tr><td colSpan={2} className="p-8 text-center text-muted-foreground">Компании появятся, когда загрузится список сотрудников</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </SettingCard>
  )
}
