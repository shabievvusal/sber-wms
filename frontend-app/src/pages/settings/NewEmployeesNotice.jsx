import { useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'

// Новые исполнители из выгрузок WMS (нет в списке сотрудников по executorId) —
// то же предложение, что на странице статистики после «Обновить данные».
export function NewEmployeesNotice({ employees, onDone }) {
  const [adding, setAdding] = useState(false)
  if (!employees?.length) return null

  const handleAdd = async () => {
    setAdding(true)
    try {
      const data = await api.addNewEmployees(employees)
      toast.success(`Добавлено сотрудников: ${data.added ?? employees.length}`)
      onDone()
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="mt-4 rounded-2xl border border-warning/30 bg-warning/[0.06] p-3">
      <div className="text-sm font-semibold text-warning">Новые сотрудники из WMS ({employees.length}):</div>
      <div className="mt-1 text-sm text-warning/90">{employees.map(e => e.fio).join(', ')}</div>
      <div className="mt-2 flex gap-2">
        <Button size="sm" disabled={adding} onClick={handleAdd}>{adding ? 'Добавление…' : 'Добавить в список'}</Button>
        <Button size="sm" variant="secondary" disabled={adding} onClick={onDone}>Скрыть</Button>
      </div>
    </div>
  )
}
