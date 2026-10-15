import { useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Select } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { ModulesCheckboxGroup } from './ModulesCheckboxGroup'
import { ALL_MODULES, VS_MODULE_LABELS, knownModules } from './constants'
import { LayoutGrid, RotateCcw, ShieldCheck, X } from 'lucide-react'
import { confirmDialog } from '@/components/ui/confirm'

// У admin/developer разделы всегда все (бэкенд добавляет их поверх списка),
// поэтому правка разделов их не касается.
const PRIVILEGED = new Set(['admin', 'developer'])

/** Применяет payloadFor(user) ко всем выбранным по очереди; null — пропустить. */
async function applyToUsers(users, payloadFor, setProgress, warehouseId) {
  let ok = 0, skipped = 0
  const failed = []
  for (let i = 0; i < users.length; i++) {
    const u = users[i]
    setProgress({ done: i, total: users.length })
    const payload = payloadFor(u)
    // роль своя на каждом складе: меняем права только на этом складе,
    // у кого его нет — пропускаем
    if (!payload || (warehouseId && !(u.warehouseIds || []).includes(warehouseId))) { skipped++; continue }
    try {
      await api.putVsAdminUser(u.login, warehouseId ? { ...payload, warehouseId } : payload)
      ok++
    } catch (err) {
      failed.push(`${u.name || u.login}: ${err.message}`)
    }
  }
  setProgress(null)
  return { ok, skipped, failed }
}

function report({ ok, skipped, failed }, what) {
  const parts = [`${what}: ${ok}`]
  if (skipped) parts.push(`пропущено ${skipped}`)
  if (failed.length) {
    toast.error(`${parts.join(' · ')} · ошибок ${failed.length}`, { description: failed.slice(0, 3).join('\n') })
  } else {
    toast.success(parts.join(' · '))
  }
}

const MODES = [
  { v: 'add', label: 'Добавить', hint: 'Выбранные разделы добавятся к тем, что уже есть' },
  { v: 'remove', label: 'Убрать', hint: 'Выбранные разделы уберутся, остальные останутся' },
  { v: 'set', label: 'Заменить', hint: 'У всех будут ровно выбранные разделы' },
]

function BulkModulesDialog({ users, warehouseId, warehouseName, onClose, onDone }) {
  const [mode, setMode] = useState('add')
  const [modules, setModules] = useState(() => new Set())
  const [progress, setProgress] = useState(null)

  const targets = users.filter(u => !PRIVILEGED.has(u.role))
  const skippedPriv = users.length - targets.length

  const toggle = m => setModules(prev => {
    const next = new Set(prev)
    next.has(m) ? next.delete(m) : next.add(m)
    return next
  })

  const apply = async () => {
    if (!modules.size && mode !== 'set') { toast.error('Выберите хотя бы один раздел'); return }
    const chosen = [...modules]
    const result = await applyToUsers(targets, u => {
      const cur = knownModules(u.modules)
      const next = mode === 'add' ? knownModules([...cur, ...chosen])
        : mode === 'remove' ? cur.filter(m => !modules.has(m))
          : knownModules(chosen)
      // пустой список на бэкенде = «как у роли», поэтому «ни одного раздела» не отправляем
      if (!next.length) return null
      return { modules: next }
    }, setProgress, warehouseId)
    report(result, 'Разделы обновлены')
    onDone()
  }

  const busy = !!progress
  return (
    <Dialog open onOpenChange={o => !o && !busy && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Разделы у {users.length} пользователей{warehouseName ? ` на складе ${warehouseName}` : ''}</DialogTitle>
          <DialogDescription>
            {skippedPriv > 0 ? `Администраторы и разработчики (${skippedPriv}) пропускаются — у них всегда все разделы.` : 'Разделы, которые увидят выбранные пользователи'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="inline-flex rounded-xl border border-line bg-surface-2 p-0.5">
            {MODES.map(m => (
              <button
                key={m.v}
                type="button"
                onClick={() => setMode(m.v)}
                className={cn('rounded-[10px] px-3 py-1.5 text-sm font-medium transition-colors', mode === m.v ? 'bg-surface text-foreground shadow-card' : 'text-muted-foreground hover:text-ink-2')}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{MODES.find(m => m.v === mode).hint}</p>
          <ModulesCheckboxGroup
            items={ALL_MODULES}
            labels={VS_MODULE_LABELS}
            selected={modules}
            onToggle={toggle}
            onSetAll={all => setModules(all ? new Set(ALL_MODULES) : new Set())}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Отмена</Button>
          <Button onClick={apply} disabled={busy || !targets.length || (!modules.size)}>
            {busy ? `Применяю… ${progress.done + 1}/${progress.total}` : `Применить к ${targets.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Панель массовых действий над выбранными пользователями (прилипает к низу
 * экрана): назначить роль, добавить/убрать/заменить разделы, вернуть разделы
 * роли.
 */
export function UsersBulkBar({ users, roles, warehouseId, warehouseName, onClear, onDone }) {
  const [role, setRole] = useState('')
  const [resetModules, setResetModules] = useState(true)
  const [progress, setProgress] = useState(null)
  const [modulesOpen, setModulesOpen] = useState(false)
  const busy = !!progress

  const assignRole = async () => {
    if (!role) { toast.error('Выберите роль'); return }
    const label = roles.find(r => r.key === role)?.label || role
    const where = warehouseName ? ` на складе ${warehouseName}` : ''
    if (!(await confirmDialog({ title: `Назначить роль «${label}»${where}?`, description: `Роль сменится у ${users.length} пользователей${where}.${resetModules ? '\nИх разделы станут такими же, как у роли.' : ''}`, confirmText: 'Назначить' }))) return
    const result = await applyToUsers(users, () => (resetModules ? { role, modules: [] } : { role }), setProgress, warehouseId)
    report(result, `Роль «${label}» назначена`)
    onDone()
  }

  const resetToRole = async () => {
    if (!(await confirmDialog({ title: 'Вернуть разделы роли?', description: `У ${users.length} пользователей личные настройки разделов сбросятся — останутся разделы их роли.`, confirmText: 'Вернуть' }))) return
    const result = await applyToUsers(users, () => ({ modules: [] }), setProgress, warehouseId)
    report(result, 'Разделы как у роли')
    onDone()
  }

  return (
    <>
      {modulesOpen && <BulkModulesDialog users={users} warehouseId={warehouseId} warehouseName={warehouseName} onClose={() => setModulesOpen(false)} onDone={() => { setModulesOpen(false); onDone() }} />}
      <div className="sticky bottom-3 z-20 mt-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-line bg-[var(--glass)] p-3 shadow-float backdrop-blur-xl">
          <span className="inline-flex items-center gap-2 text-sm font-medium">
            <span className="grid h-6 min-w-6 place-items-center rounded-full bg-brand px-1.5 text-xs font-semibold text-white">{users.length}</span>
            выбрано
          </span>
          {warehouseName && <span className="text-xs text-muted-foreground">права на складе {warehouseName}</span>}
          <div className="h-6 w-px bg-line" />
          <div className="flex flex-wrap items-center gap-2">
            <Select className="h-8 w-48" value={role} onChange={e => setRole(e.target.value)} placeholder="Роль…">
              <option value="">Роль…</option>
              {roles.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
            </Select>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground" title="Сбросить личные настройки разделов — разделы будут как у новой роли">
              <Checkbox checked={resetModules} onCheckedChange={v => setResetModules(!!v)} />
              разделы как у роли
            </label>
            <Button size="sm" variant="outline" onClick={assignRole} disabled={busy || !role}><ShieldCheck className="size-3.5" /> Назначить</Button>
          </div>
          <div className="h-6 w-px bg-line" />
          <Button size="sm" variant="outline" onClick={() => setModulesOpen(true)} disabled={busy}><LayoutGrid className="size-3.5" /> Разделы…</Button>
          <Button size="sm" variant="ghost" onClick={resetToRole} disabled={busy} title="Убрать личные настройки разделов"><RotateCcw className="size-3.5" /> Как у роли</Button>
          <div className="ml-auto flex items-center gap-2">
            {busy && <span className="tabular text-xs text-muted-foreground">Применяю… {progress.done + 1}/{progress.total}</span>}
            <button type="button" onClick={onClear} disabled={busy} title="Снять выделение" className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-surface-2 hover:text-foreground">
              <X className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
