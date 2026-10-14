import { useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { SettingCard } from './SettingCard'
import { ModulesCheckboxGroup } from './ModulesCheckboxGroup'
import { ALL_MODULES, VS_MODULE_LABELS, knownModules } from './constants'
import { RolesMatrix } from './RolesMatrix'
import { cn } from '@/lib/utils'
import { Field, IconAction, ModuleChips } from './ui'
import { Grid3x3, List, Lock, Pencil, Plus, Search, Shield, Trash2 } from 'lucide-react'
import { confirmDialog } from '@/components/ui/confirm'

/** Окно создания/правки роли. role = null → новая. */
function RoleDialog({ role, onClose, onSaved }) {
  const isNew = !role
  const [label, setLabel] = useState(role?.label || '')
  const [modules, setModules] = useState(() => new Set(role?.modules || []))
  const [saving, setSaving] = useState(false)

  const toggle = m => setModules(prev => {
    const next = new Set(prev)
    next.has(m) ? next.delete(m) : next.add(m)
    return next
  })

  const save = async () => {
    if (!label.trim()) { toast.error('Введите название роли'); return }
    setSaving(true)
    try {
      if (isNew) await api.addVsAdminRole('', label.trim(), knownModules([...modules]))
      else await api.updateVsAdminRole(role.key, label.trim(), knownModules([...modules]))
      toast.success(isNew ? 'Роль добавлена' : 'Роль обновлена')
      onSaved()
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Новая роль' : 'Изменить роль'}</DialogTitle>
          <DialogDescription>{isNew ? 'Название и разделы, доступные пользователям с этой ролью' : `Ключ: ${role.key}`}</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <Field label="Название">
            <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="Например, Кладовщик" autoFocus />
          </Field>
          <div className="space-y-2">
            <div className="text-sm font-medium">Разделы</div>
            <ModulesCheckboxGroup
              items={ALL_MODULES}
              labels={VS_MODULE_LABELS}
              selected={modules}
              onToggle={toggle}
              onSetAll={all => setModules(all ? new Set(ALL_MODULES) : new Set())}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'Сохранение…' : isNew ? 'Создать роль' : 'Сохранить'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function RolesCard({ roles, onChanged }) {
  const [dialog, setDialog] = useState(null) // null — закрыто, { role: null } — новая, { role } — правка
  const [search, setSearch] = useState('')
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('settings_roles_view') || 'matrix' } catch { return 'matrix' }
  })
  const changeView = v => { setView(v); try { localStorage.setItem('settings_roles_view', v) } catch { /* ignore */ } }

  const handleDelete = async r => {
    if (!(await confirmDialog({ title: `Удалить роль «${r.label}»?`, description: 'Пользователи с этой ролью получат роль по умолчанию — «Менеджер».', confirmText: 'Удалить роль', danger: true }))) return
    try {
      await api.deleteVsAdminRole(r.key)
      toast.success('Роль удалена')
      onChanged(null)
    } catch (err) { toast.error('Ошибка: ' + err.message) }
  }

  const q = search.trim().toLowerCase()
  const filtered = roles.filter(r => !q || r.key.includes(q) || r.label.toLowerCase().includes(q))

  return (
    <SettingCard
      icon={Shield}
      title="Роли"
      subtitle={view === 'matrix' ? 'Матрица доступа: клик по клетке — раздел у роли, по заголовку — у всех своих ролей' : 'Набор разделов, который получает пользователь с этой ролью'}
      actions={
        <>
          <div className="inline-flex rounded-xl border border-line bg-surface-2 p-0.5">
            {[{ v: 'matrix', label: 'Матрица', Icon: Grid3x3 }, { v: 'list', label: 'Список', Icon: List }].map(({ v, label, Icon }) => (
              <button
                key={v}
                type="button"
                onClick={() => changeView(v)}
                className={cn('inline-flex items-center gap-1.5 rounded-[10px] px-2.5 py-1 text-xs font-medium transition-colors', view === v ? 'bg-surface text-foreground shadow-card' : 'text-muted-foreground hover:text-ink-2')}
              >
                <Icon className="size-3.5" /> {label}
              </button>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={() => setDialog({ role: null })}><Plus className="size-3.5" /> Новая роль</Button>
        </>
      }
      bodyClassName={view === 'matrix' ? 'p-4' : 'p-2'}
    >
      {dialog && <RoleDialog role={dialog.role} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); onChanged(null) }} />}

      {view === 'matrix' ? <RolesMatrix roles={roles} onSaved={() => onChanged(null)} /> : (<>

      {roles.length > 6 && (
        <div className="relative px-2 pt-1 pb-2">
          <Search className="pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Поиск роли" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      )}

      <ul>
        {filtered.map(r => (
          <li key={r.key} className="group flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl px-3 py-2.5 transition-colors hover:bg-surface-2/50">
            <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${r.builtin ? 'bg-surface-2 text-ink-2' : 'bg-brand-soft text-brand'}`}>
              {r.builtin ? <Lock className="size-4" /> : <Shield className="size-4" />}
            </span>
            <div className="min-w-0 basis-44">
              <div className="truncate text-sm font-medium">{r.label}</div>
              <div className="truncate font-mono text-xs text-muted-foreground">{r.key}{r.builtin ? ' · встроенная' : ''}</div>
            </div>
            <div className="min-w-0 flex-1 basis-60">
              <ModuleChips modules={r.modules} max={4} />
            </div>
            <div className="flex w-[72px] shrink-0 justify-end gap-0.5">
              {!r.builtin && (
                <>
                  <IconAction icon={Pencil} title="Изменить роль" tone="brand" onClick={() => setDialog({ role: r })} />
                  <IconAction icon={Trash2} title="Удалить роль" tone="danger" onClick={() => handleDelete(r)} />
                </>
              )}
            </div>
          </li>
        ))}
        {!filtered.length && <li className="p-6 text-center text-sm text-muted-foreground">Ничего не найдено</li>}
      </ul>
      </>)}
    </SettingCard>
  )
}
