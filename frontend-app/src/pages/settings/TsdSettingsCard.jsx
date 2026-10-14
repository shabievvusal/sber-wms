import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { withMinDuration } from '@/lib/timing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EditableCell } from '@/components/ui/editable-cell'
import { SettingCard, SettingRow } from './SettingCard'
import { Empty, IconAction, theadCls, thCls, trCls, tableWrapCls } from './ui'
import { Plus, ScanBarcode, Trash2, UserRoundPlus } from 'lucide-react'

export function TsdSettingsCard() {
  const [totalCount, setTotalCount] = useState('0')
  const [savedCount, setSavedCount] = useState('0')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.getTsdSettings()
      .then(data => { const v = String(data?.totalCount ?? 0); setTotalCount(v); setSavedCount(v) })
      .catch(() => {})
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await withMinDuration(async () => {
        const data = await api.updateTsdSettings(totalCount)
        const v = String(data?.totalCount ?? totalCount)
        setTotalCount(v); setSavedCount(v)
      })
      toast.success('Количество ТСД сохранено')
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingCard icon={ScanBarcode} title="ТСД" subtitle="Парк терминалов для раздела «Выдача ТСД»">
      <SettingRow label="Рабочих ТСД" desc="Из этого числа считается остаток при выдаче">
        <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); handleSave() }}>
          <Input className="tabular w-24 text-right" type="number" min="0" value={totalCount} onChange={e => setTotalCount(e.target.value)} />
          <Button type="submit" size="sm" variant={totalCount !== savedCount ? 'default' : 'outline'} disabled={saving || totalCount === savedCount}>
            {saving ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </form>
      </SettingRow>
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

  const handleCommit = async (row, field, value) => {
    const trimmed = value.trim()
    if (trimmed === row[field]) return
    if (field === 'fio' && !trimmed) { toast.error('ФИО не может быть пустым'); return }
    const patch = { fio: row.fio, company: row.company, [field]: trimmed }
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
    if (!confirm(`Удалить «${row.fio}» из списка для ТСД?`)) return
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
      icon={UserRoundPlus}
      title="Сотрудники без ID (для ТСД)"
      subtitle="Не появляются в статистике WMS — заводятся вручную только для выдачи ТСД. Изменения сохраняются сразу."
    >
      <form className="mb-4 flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); handleAdd() }}>
        <Input className="min-w-0 flex-1 basis-56" placeholder="ФИО" value={newFio} onChange={e => setNewFio(e.target.value)} />
        <Input className="min-w-0 flex-1 basis-44" placeholder="Компания (необязательно)" value={newCompany} onChange={e => setNewCompany(e.target.value)} />
        <Button type="submit" variant="outline" disabled={adding || !newFio.trim()}><Plus className="size-4" /> {adding ? 'Добавление…' : 'Добавить'}</Button>
      </form>

      {loading ? (
        <div className="text-sm text-muted-foreground">Загрузка…</div>
      ) : rows.length === 0 ? (
        <Empty>Список пуст</Empty>
      ) : (
        <div className={tableWrapCls}>
          <table className="w-full table-fixed text-sm">
            <colgroup><col className="w-[55%]" /><col /><col className="w-12" /></colgroup>
            <thead className={theadCls}>
              <tr className="border-b border-line">
                <th className={thCls}>ФИО</th>
                <th className={thCls}>Компания</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} className={trCls}>
                  <td className="px-1 py-1.5"><EditableCell value={row.fio} placeholder="ФИО" className="font-medium" onCommit={v => handleCommit(row, 'fio', v)} /></td>
                  <td className="px-1 py-1.5"><EditableCell value={row.company || ''} placeholder="без компании" onCommit={v => handleCommit(row, 'company', v)} /></td>
                  <td className="py-1.5 pr-2 text-right">
                    <IconAction icon={Trash2} title="Удалить" tone="danger" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => handleDelete(row)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingCard>
  )
}
