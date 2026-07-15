import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingCard, SettingRow } from './SettingCard'
import { ScanBarcode, X } from 'lucide-react'

export function TsdSettingsCard() {
  const [totalCount, setTotalCount] = useState('0')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.getTsdSettings()
      .then(data => setTotalCount(String(data?.totalCount ?? 0)))
      .catch(() => {})
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await withMinDuration(async () => {
        const data = await api.updateTsdSettings(totalCount)
        setTotalCount(String(data?.totalCount ?? totalCount))
      })
      toast.success('Количество ТСД сохранено')
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingCard icon={ScanBarcode} title="ТСД" subtitle="Общее количество рабочих устройств">
      <SettingRow label="Рабочих ТСД" desc="Используется для расчёта остатка в разделе выдачи ТСД">
        <Input className="w-28" type="number" min="0" value={totalCount} onChange={e => setTotalCount(e.target.value)} />
      </SettingRow>
      <div className="pt-3">
        <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? 'Сохранение...' : 'Сохранить'}</Button>
      </div>
    </SettingCard>
  )
}

// Сотрудники без executorId — не встречаются в статистике WMS (значит их
// нет в общем списке api.getEmployees()), но им всё равно нужно выдавать
// физический ТСД. Заводим вручную здесь, с компанией — но эти записи
// используются ИСКЛЮЧИТЕЛЬНО разделом «Выдача ТСД» (TsdIssuePage.jsx
// подмешивает их в общий список как второй источник), в статистику и
// мониторинг они не попадают вообще — отдельная таблица на бэкенде
// (tsd_manual_employees), не /api/employees.
export function TsdManualEmployeesCard() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [newFio, setNewFio] = useState('')
  const [newCompany, setNewCompany] = useState('')
  const [adding, setAdding] = useState(false)

  const load = () => {
    setLoading(true)
    return api.getTsdManualEmployees()
      .then(data => setRows(data?.employees || []))
      .catch(err => toast.error('Ошибка: ' + err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const handleAdd = async () => {
    const fio = newFio.trim()
    if (!fio) { toast.error('Введите ФИО'); return }
    setAdding(true)
    try {
      const data = await api.addTsdManualEmployee(fio, newCompany.trim())
      if (!data.ok) { toast.error('Ошибка: ' + data.error); return }
      setRows(prev => [...prev, data.employee])
      setNewFio(''); setNewCompany('')
      toast.success('Сотрудник добавлен')
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setAdding(false)
    }
  }

  const handleFieldBlur = async (row, field, value) => {
    const trimmed = value.trim()
    if (trimmed === row[field]) return
    const patch = { fio: row.fio, company: row.company, [field]: trimmed }
    if (field === 'fio' && !trimmed) { toast.error('ФИО не может быть пустым'); load(); return }
    try {
      const data = await api.updateTsdManualEmployee(row.id, patch.fio, patch.company)
      if (!data.ok) { toast.error('Ошибка: ' + data.error); load(); return }
      setRows(prev => prev.map(r => r.id === row.id ? data.employee : r))
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
      load()
    }
  }

  const handleDelete = async row => {
    try {
      const data = await api.deleteTsdManualEmployee(row.id)
      if (!data.ok) { toast.error('Не удалось удалить'); return }
      setRows(prev => prev.filter(r => r.id !== row.id))
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    }
  }

  return (
    <SettingCard
      icon={ScanBarcode}
      title="Сотрудники без ID (для ТСД)"
      subtitle="Не появляются в статистике WMS — добавляются вручную только для выдачи ТСД"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input className="h-8 w-56" placeholder="ФИО" value={newFio} onChange={e => setNewFio(e.target.value)} />
        <Input className="h-8 w-44" placeholder="Компания" value={newCompany} onChange={e => setNewCompany(e.target.value)} />
        <Button size="sm" onClick={handleAdd} disabled={adding}>{adding ? 'Добавление...' : '+ Добавить'}</Button>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Загрузка...</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">Список пуст</div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="p-2 text-left font-medium">ФИО</th>
                <th className="p-2 text-left font-medium">Компания</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <TsdManualEmployeeRow key={row.id} row={row} onFieldBlur={handleFieldBlur} onDelete={() => handleDelete(row)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingCard>
  )
}

function TsdManualEmployeeRow({ row, onFieldBlur, onDelete }) {
  const [fio, setFio] = useState(row.fio)
  const [company, setCompany] = useState(row.company)

  return (
    <tr className="border-b last:border-0">
      <td className="p-1.5"><Input className="h-8" value={fio} onChange={e => setFio(e.target.value)} onBlur={() => onFieldBlur(row, 'fio', fio)} /></td>
      <td className="p-1.5"><Input className="h-8" value={company} onChange={e => setCompany(e.target.value)} onBlur={() => onFieldBlur(row, 'company', company)} /></td>
      <td className="p-1.5 text-right">
        <Button size="icon" variant="ghost" onClick={onDelete} title="Удалить"><X className="size-3.5" /></Button>
      </td>
    </tr>
  )
}
