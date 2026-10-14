import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ALL_MODULES, VS_MODULE_LABELS, knownModules } from './constants'
import { Check, Lock, Save, Undo2 } from 'lucide-react'

const sameList = (a, b) => a.length === b.length && a.every(x => b.includes(x))

/**
 * Матрица доступа «роли × разделы» — массовая правка: клик по клетке
 * включает/выключает раздел у роли, клик по заголовку раздела — у всех своих
 * ролей сразу, «все» в строке — все разделы роли. Встроенные роли только для
 * просмотра (их разделы зашиты в бэкенде). Изменения копятся и сохраняются
 * разом из панели внизу.
 */
export function RolesMatrix({ roles, onSaved }) {
  const original = useMemo(() => Object.fromEntries(roles.map(r => [r.key, knownModules(r.modules)])), [roles])
  const [draft, setDraft] = useState(original)
  const [saving, setSaving] = useState(false)

  // роли пришли заново (после сохранения/добавления) — начинаем с них
  const [prevRoles, setPrevRoles] = useState(roles)
  if (prevRoles !== roles) { setPrevRoles(roles); setDraft(original) }

  const editable = roles.filter(r => !r.builtin)
  const changedKeys = editable.filter(r => !sameList(draft[r.key] || [], original[r.key] || [])).map(r => r.key)

  const has = (key, m) => (draft[key] || []).includes(m)
  const setModules = (key, list) => setDraft(d => ({ ...d, [key]: knownModules(list) }))
  const toggle = (key, m) => setModules(key, has(key, m) ? draft[key].filter(x => x !== m) : [...(draft[key] || []), m])

  const toggleColumn = m => {
    const allOn = editable.length > 0 && editable.every(r => has(r.key, m))
    setDraft(d => {
      const next = { ...d }
      for (const r of editable) {
        const cur = next[r.key] || []
        next[r.key] = knownModules(allOn ? cur.filter(x => x !== m) : [...cur, m])
      }
      return next
    })
  }

  const toggleRow = key => setModules(key, (draft[key] || []).length === ALL_MODULES.length ? [] : ALL_MODULES)

  const save = async () => {
    setSaving(true)
    let ok = 0
    try {
      for (const key of changedKeys) {
        const role = roles.find(r => r.key === key)
        await api.updateVsAdminRole(key, role.label, draft[key])
        ok++
      }
      toast.success(`Сохранено ролей: ${ok}`)
      onSaved()
    } catch (err) {
      toast.error(`Ошибка (сохранено ${ok} из ${changedKeys.length}): ${err.message}`)
      if (ok) onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="overflow-x-auto rounded-2xl border border-line">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 min-w-48 border-b border-line bg-surface-2 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Роль</th>
              {ALL_MODULES.map(m => (
                <th key={m} className="min-w-[76px] border-b border-line bg-surface-2/60 px-1 py-1.5 align-bottom">
                  <button
                    type="button"
                    disabled={!editable.length}
                    onClick={() => toggleColumn(m)}
                    title={`«${VS_MODULE_LABELS[m]}» — включить/выключить у всех своих ролей`}
                    className="w-full rounded-lg px-1 py-1 text-[11px] font-medium leading-tight text-ink-2 transition-colors hover:bg-brand-soft hover:text-brand disabled:pointer-events-none"
                  >
                    {VS_MODULE_LABELS[m]}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {roles.map(r => {
              const ro = r.builtin
              const count = (draft[r.key] || []).length
              return (
                <tr key={r.key} className="group">
                  <td className="sticky left-0 z-10 border-b border-line bg-card px-3 py-1.5 group-last:border-0">
                    <div className="flex items-center gap-2">
                      {ro && <Lock className="size-3.5 shrink-0 text-muted-foreground" />}
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{r.label}</div>
                        <div className="text-[11px] text-muted-foreground">{ro ? 'встроенная' : `${count} из ${ALL_MODULES.length}`}</div>
                      </div>
                      {!ro && (
                        <button type="button" onClick={() => toggleRow(r.key)} className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-brand opacity-0 transition-opacity hover:bg-brand-soft group-hover:opacity-100 focus-visible:opacity-100">
                          {count === ALL_MODULES.length ? 'снять' : 'все'}
                        </button>
                      )}
                    </div>
                  </td>
                  {ALL_MODULES.map(m => {
                    const on = has(r.key, m)
                    const changed = !ro && on !== (original[r.key] || []).includes(m)
                    return (
                      <td key={m} className="border-b border-line p-1 text-center group-last:border-0">
                        <button
                          type="button"
                          disabled={ro}
                          onClick={() => toggle(r.key, m)}
                          aria-pressed={on}
                          title={`${r.label} · ${VS_MODULE_LABELS[m]}`}
                          className={cn(
                            'mx-auto grid size-8 place-items-center rounded-lg border transition-colors',
                            on ? 'border-transparent bg-brand text-white' : 'border-line bg-surface text-transparent hover:border-line-strong',
                            ro && (on ? 'bg-brand/45' : 'opacity-60'),
                            !ro && !on && 'hover:text-muted-foreground',
                            changed && 'ring-2 ring-warning ring-offset-1 ring-offset-card',
                          )}
                        >
                          <Check className="size-4" strokeWidth={3} />
                        </button>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {!editable.length && (
        <p className="mt-3 text-sm text-muted-foreground">Своих ролей пока нет — встроенные менять нельзя. Создайте роль кнопкой «Новая роль».</p>
      )}

      {changedKeys.length > 0 && (
        <div className="sticky bottom-3 z-20 mt-3">
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-[var(--glass)] p-3 shadow-float backdrop-blur-xl">
            <span className="size-2 shrink-0 rounded-full bg-warning" />
            <div className="min-w-0 flex-1 text-sm">
              <span className="font-medium">Изменено ролей: {changedKeys.length}</span>
              <span className="text-muted-foreground"> · {changedKeys.map(k => roles.find(r => r.key === k)?.label).join(', ')}</span>
            </div>
            <Button variant="ghost" onClick={() => setDraft(original)} disabled={saving}><Undo2 className="size-4" /> Отменить</Button>
            <Button onClick={save} disabled={saving}><Save className="size-4" /> {saving ? 'Сохранение…' : 'Сохранить'}</Button>
          </div>
        </div>
      )}
    </div>
  )
}
