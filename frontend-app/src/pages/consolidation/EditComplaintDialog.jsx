import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

const selectClass = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

/** Порт EditModal оригинала — ручная коррекция результатов поиска нарушителя. */
export function EditComplaintDialog({ complaint, onOpenChange, onSaved }) {
  const [company, setCompany] = useState(complaint.company || '')
  const [violator, setViolator] = useState(complaint.violator || '')
  const [taskArea, setTaskArea] = useState(complaint.taskArea === 'kdk' ? 'kdk' : 'storage')
  const [cell, setCell] = useState(complaint.cell || '')
  const [barcode, setBarcode] = useState(complaint.barcode || '')
  const [nomenclatureCode, setNomenclatureCode] = useState(complaint.nomenclatureCode || '')
  const [productName, setProductName] = useState(complaint.productName || '')
  const [productBarcode, setProductBarcode] = useState(complaint.productBarcode || '')
  const [handlingUnitBarcode, setHandlingUnitBarcode] = useState(complaint.handlingUnitBarcode || '')
  const [companies, setCompanies] = useState([])
  const [employees, setEmployees] = useState([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.getEmployees()
      .then(data => { setCompanies(data.companies || []); setEmployees(data.employees || []) })
      .catch(() => { setCompanies([]); setEmployees([]) })
  }, [])

  const employeesForCompany = employees.filter(e => e.company === company)

  const handleSave = async () => {
    if (!company) { toast.error('Выберите компанию'); return }
    if (!violator) { toast.error('Выберите сотрудника (нарушителя)'); return }
    const payload = {
      company, violator,
      taskArea, cell: cell.trim(), barcode: barcode.trim(),
      nomenclatureCode: nomenclatureCode.trim(), productName: productName.trim(),
      productBarcode: productBarcode.trim(), handlingUnitBarcode: handlingUnitBarcode.trim(),
      lookupDone: true, lookupError: null,
    }
    setSaving(true)
    try {
      await api.saveComplaintLookup(complaint.id, payload)
      toast.success('Сохранено')
      onSaved({ ...complaint, ...payload })
    } catch (err) {
      toast.error('Ошибка сохранения: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Редактировать жалобу</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Компания</span>
            <select className={selectClass} value={company} onChange={e => { setCompany(e.target.value); setViolator('') }}>
              <option value="">— Выберите компанию —</option>
              {companies.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>

          <label className="block space-y-1 text-sm">
            <span className="font-medium">Сотрудник (нарушитель)</span>
            <select className={selectClass} value={violator} onChange={e => setViolator(e.target.value)}>
              <option value="">— Выберите сотрудника —</option>
              {employeesForCompany.map(e => <option key={e.fio} value={e.fio}>{e.fio}</option>)}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Где выполнял задачу</span>
              <select className={selectClass} value={taskArea} onChange={e => setTaskArea(e.target.value)}>
                <option value="storage">В хранении</option>
                <option value="kdk">В КДК</option>
              </select>
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Место</span>
              <Input value={cell} onChange={e => setCell(e.target.value)} placeholder="KDH-4-44" />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Штрихкод / ЕО</span>
              <Input value={barcode} onChange={e => setBarcode(e.target.value)} placeholder="Штрихкод" />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Артикул</span>
              <Input value={nomenclatureCode} onChange={e => setNomenclatureCode(e.target.value)} placeholder="УТ-00000000" />
            </label>
            <label className="col-span-2 block space-y-1 text-sm">
              <span className="font-medium">Товар</span>
              <Input value={productName} onChange={e => setProductName(e.target.value)} placeholder="Название товара" />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">ШК товара</span>
              <Input value={productBarcode} onChange={e => setProductBarcode(e.target.value)} placeholder="4600..." />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">ЕО</span>
              <Input value={handlingUnitBarcode} onChange={e => setHandlingUnitBarcode(e.target.value)} placeholder="0122..." />
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? 'Сохранение...' : 'Сохранить'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
