import { useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { SettingCard } from './SettingCard'
import { ModulesCheckboxGroup } from './ModulesCheckboxGroup'
import { ALL_MODULES, VS_MODULE_LABELS } from './constants'
import { Theater, X } from 'lucide-react'

function toggleInSet(setFn, key) {
  setFn(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })
}

export function RolesCard({ roles, onChanged }) {
  const [showAdd, setShowAdd] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newModules, setNewModules] = useState(() => new Set())
  const [editKey, setEditKey] = useState(null)
  const [editLabel, setEditLabel] = useState('')
  const [editModules, setEditModules] = useState(() => new Set())
  const [search, setSearch] = useState('')

  const handleAdd = async () => {
    if (!newLabel.trim()) { toast.error('Введите название роли'); return }
    try {
      await api.addVsAdminRole('', newLabel.trim(), [...newModules])
      toast.success('Роль добавлена')
      setShowAdd(false); setNewLabel(''); setNewModules(new Set())
      onChanged(null)
    } catch (err) { toast.error('Ошибка: ' + err.message) }
  }

  const handleUpdate = async () => {
    try {
      await api.updateVsAdminRole(editKey, editLabel.trim(), [...editModules])
      toast.success('Роль обновлена')
      onChanged(null)
      setEditKey(null)
    } catch (err) { toast.error('Ошибка: ' + err.message) }
  }

  const handleDelete = async key => {
    if (!confirm('Удалить роль?')) return
    try {
      await api.deleteVsAdminRole(key)
      toast.success('Роль удалена')
      onChanged(null)
    } catch (err) { toast.error('Ошибка: ' + err.message) }
  }

  const startEdit = r => { setEditKey(r.key); setEditLabel(r.label); setEditModules(new Set(r.modules || [])) }

  const q = search.trim().toLowerCase()
  const filtered = roles.filter(r => !q || r.key.includes(q) || r.label.toLowerCase().includes(q))

  return (
    <SettingCard
      icon={Theater}
      title="Роли"
      subtitle="Встроенные и кастомные роли с правами на модули"
      actions={<Button size="sm" onClick={() => setShowAdd(v => !v)}>+ Новая роль</Button>}
    >
      <Input className="mb-3" placeholder="Поиск по ключу или названию..." value={search} onChange={e => setSearch(e.target.value)} />

      {showAdd && (
        <div className="mb-4 space-y-3 rounded-lg border bg-muted/30 p-4">
          <div className="font-medium">Новая роль</div>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Название</span>
            <Input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Кладовщик" autoFocus />
          </label>
          <div className="space-y-1.5 text-sm">
            <span className="font-medium">Модули</span>
            <ModulesCheckboxGroup items={ALL_MODULES} labels={VS_MODULE_LABELS} selected={newModules} onToggle={m => toggleInSet(setNewModules, m)} />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleAdd}>Добавить</Button>
            <Button size="sm" variant="secondary" onClick={() => { setShowAdd(false); setNewLabel(''); setNewModules(new Set()) }}>Отмена</Button>
          </div>
        </div>
      )}

      {/* Мобильные карточки — до md (768px). Строка редактирования становится
          вертикальной мини-формой вместо строки с инпутом и чекбоксами. */}
      <div className="divide-y rounded-md border md:hidden">
        {filtered.map(r => editKey === r.key ? (
          <div key={r.key} className="space-y-2 p-3 text-sm">
            <div className="text-xs text-muted-foreground">{r.key}</div>
            <Input className="h-8" value={editLabel} onChange={e => setEditLabel(e.target.value)} />
            <ModulesCheckboxGroup items={ALL_MODULES} labels={VS_MODULE_LABELS} selected={editModules} onToggle={m => toggleInSet(setEditModules, m)} />
            <div className="flex gap-1.5">
              <Button size="sm" onClick={handleUpdate}>Сохранить</Button>
              <Button size="icon" variant="ghost" onClick={() => setEditKey(null)}><X className="size-3.5" /></Button>
            </div>
          </div>
        ) : (
          <div key={r.key} className="space-y-1.5 p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className={r.builtin ? 'font-semibold' : 'font-medium'}>{r.label}</span>
              {r.builtin && <Badge variant="secondary">встроенная</Badge>}
            </div>
            <div className="text-xs text-muted-foreground">{r.key}</div>
            <div className="truncate text-xs text-muted-foreground" title={r.modules?.map(m => VS_MODULE_LABELS[m] || m).join(', ')}>
              {r.modules?.length ? r.modules.map(m => VS_MODULE_LABELS[m] || m).join(', ') : '—'}
            </div>
            {!r.builtin && (
              <div className="flex gap-1.5 pt-0.5">
                <Button size="sm" variant="outline" onClick={() => startEdit(r)}>Изменить</Button>
                <Button size="sm" variant="destructive" onClick={() => handleDelete(r.key)}>Удалить</Button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Десктопная таблица — от md и шире */}
      <div className="hidden overflow-x-auto rounded-md border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ключ</TableHead>
              <TableHead>Название</TableHead>
              <TableHead>Модули</TableHead>
              <TableHead className="text-right">Действия</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map(r => editKey === r.key ? (
              <TableRow key={r.key}>
                <TableCell className="text-xs text-muted-foreground">{r.key}</TableCell>
                <TableCell><Input className="h-8" value={editLabel} onChange={e => setEditLabel(e.target.value)} /></TableCell>
                <TableCell>
                  <ModulesCheckboxGroup items={ALL_MODULES} labels={VS_MODULE_LABELS} selected={editModules} onToggle={m => toggleInSet(setEditModules, m)} />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" onClick={handleUpdate}>Сохранить</Button>
                    <Button size="icon" variant="ghost" onClick={() => setEditKey(null)}><X className="size-3.5" /></Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              <TableRow key={r.key}>
                <TableCell className="text-xs text-muted-foreground">{r.key}</TableCell>
                <TableCell className={r.builtin ? 'font-semibold' : ''}>
                  {r.label} {r.builtin && <Badge variant="secondary" className="ml-1">встроенная</Badge>}
                </TableCell>
                <TableCell className="max-w-64 truncate text-xs text-muted-foreground" title={r.modules?.map(m => VS_MODULE_LABELS[m] || m).join(', ')}>
                  {r.modules?.length ? r.modules.map(m => VS_MODULE_LABELS[m] || m).join(', ') : '—'}
                </TableCell>
                <TableCell className="text-right">
                  {!r.builtin && (
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => startEdit(r)}>Изменить</Button>
                      <Button size="sm" variant="destructive" onClick={() => handleDelete(r.key)}>Удалить</Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SettingCard>
  )
}
