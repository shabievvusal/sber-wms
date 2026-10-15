import { useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select } from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { ModulesCheckboxGroup } from './ModulesCheckboxGroup'
import { ALL_MODULES, VS_MODULE_LABELS, ALL_ACTIONS, VS_ACTION_LABELS, knownModules } from './constants'
import { Field } from './ui'
import { useAuth } from '@/context/AuthContext'
import { getWarehouseId, shortWarehouseName } from '@/lib/warehouse'
import { cn } from '@/lib/utils'
import { Check } from 'lucide-react'

function Section({ title, hint, children }) {
  return (
    <section className="space-y-3 border-t border-line pt-4 first:border-0 first:pt-0">
      <div>
        <div className="text-sm font-semibold">{title}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </section>
  )
}

function SwitchRow({ label, desc, checked, onChange }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4">
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {desc && <span className="block text-xs text-muted-foreground">{desc}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

const toggleIn = (set, key) => {
  const next = new Set(set)
  next.has(key) ? next.delete(key) : next.add(key)
  return next
}

/**
 * Карточка пользователя. Роль своя на каждом складе: у каждого склада —
 * роль, разделы и действия (сервер: vs_user_warehouses). Склады — только те,
 * которыми управляет текущий администратор; остальные склады пользователя
 * не показываются и не меняются.
 */
export function EditUserDialog({ user, open, onOpenChange, roles, emplCompanies = [], onSaved }) {
  const isNew = !user?.login
  const [login, setLogin] = useState(user?.login || '')
  const [name, setName] = useState(user?.name || '')
  const [companies, setCompanies] = useState((user?.companyIds || []).join(', '))
  const [allowWithoutToken, setAllowWithoutToken] = useState(!!user?.allowWithoutToken)
  const [selfOnly, setSelfOnly] = useState(!!user?.selfOnly)
  const [visibleCompanies, setVisibleCompanies] = useState(() => new Set(user?.visibleCompanies || []))
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)

  const { user: me } = useAuth()
  const myWarehouses = me?.warehouses || []
  const whLabel = id => shortWarehouseName(myWarehouses.find(w => w.id === id)?.name || '')
  const warehouseIds = myWarehouses.map(w => w.id).sort((a, b) => whLabel(a).localeCompare(whLabel(b), 'ru'))
  const otherWarehouses = user?.otherWarehouses || 0
  const defaultRole = roles.some(r => r.key === 'manager') ? 'manager' : roles[0]?.key || 'manager'

  // права на каждом складе (и на тех, что сейчас не отмечены — чтобы при
  // повторной отметке вернулось как было)
  const [rights, setRights] = useState(() => Object.fromEntries(warehouseIds.map(id => {
    const a = user?.access?.[id]
    return [id, { role: a?.role || user?.role || defaultRole, modules: new Set(a?.modules || []), actions: new Set(a?.actions || []) }]
  })))
  const [checked, setChecked] = useState(() => new Set(isNew ? [getWarehouseId()].filter(id => warehouseIds.includes(id)) : (user?.warehouseIds || [])))
  const checkedList = warehouseIds.filter(id => checked.has(id))
  const [editWh, setEditWh] = useState(() => checkedList.includes(getWarehouseId()) ? getWarehouseId() : checkedList[0] || null)
  const shownWh = checked.has(editWh) ? editWh : checkedList[0] || null
  const cur = shownWh ? rights[shownWh] : null

  const patch = (id, fn) => setRights(prev => ({ ...prev, [id]: { ...prev[id], ...fn(prev[id]) } }))
  const toggleWarehouse = id => {
    setChecked(prev => toggleIn(prev, id))
    if (!checked.has(id)) setEditWh(id)
  }
  const anyManager = checkedList.some(id => rights[id].role === 'manager')

  const handleSave = async () => {
    const trimmedLogin = login.trim()
    if (!trimmedLogin) { toast.error('Введите логин (номер)'); return }
    if (!checked.size && !otherWarehouses) { toast.error('Выберите хотя бы один склад'); return }
    const companyIds = anyManager ? companies.split(/[,;]/).map(x => x.trim()).filter(Boolean) : []
    const access = checkedList.map(id => ({
      warehouseId: id,
      role: rights[id].role,
      modules: knownModules([...rights[id].modules]),
      actions: [...rights[id].actions],
    }))
    const payload = {
      name: name.trim(), companyIds, visibleCompanies: [...visibleCompanies], allowWithoutToken, selfOnly, access,
    }
    if (password.trim()) payload.password = password.trim()

    setSaving(true)
    try {
      await api.putVsAdminUser(trimmedLogin, payload)
      toast.success('Сохранено')
      const main = access.find(a => a.warehouseId === getWarehouseId()) || access[0]
      onSaved({
        login: trimmedLogin, name: payload.name, companyIds, visibleCompanies: payload.visibleCompanies, allowWithoutToken, selfOnly,
        hasAccess: true,
        warehouseIds: checkedList,
        access: Object.fromEntries(access.map(a => [a.warehouseId, { role: a.role, modules: a.modules, actions: a.actions }])),
        ...(main ? { role: main.role, modules: main.modules, actions: main.actions } : {}),
      })
    } catch (err) {
      toast.error('Ошибка: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const companyLabels = Object.fromEntries(emplCompanies.map(c => [c, c]))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Новый пользователь' : (name || login)}</DialogTitle>
          <DialogDescription>{isNew ? 'Логин — номер телефона в формате 79161234567' : `Логин ${login}`}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <Section title="Учётная запись">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Логин (номер телефона)">
                <Input value={login} onChange={e => setLogin(e.target.value)} disabled={!isNew} placeholder="79161234567" />
              </Field>
              <Field label="ФИО">
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="Иванов Иван Иванович" />
              </Field>
              <Field label="Пароль" hint="Оставьте пустым, чтобы не менять">
                <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Новый пароль" />
              </Field>
              {anyManager && (
                <Field label="Компании менеджера" hint="Через запятую">
                  <Input value={companies} onChange={e => setCompanies(e.target.value)} placeholder="ООО Компания, ИП Иванов" />
                </Field>
              )}
            </div>
            <div className="space-y-3 rounded-2xl bg-surface-2/60 p-3.5">
              <SwitchRow label="Вход без токена WMS" desc="Можно войти только с паролем сайта" checked={allowWithoutToken} onChange={setAllowWithoutToken} />
              <SwitchRow label="Только свои данные" desc="Видит статистику только по себе" checked={selfOnly} onChange={setSelfOnly} />
            </div>
          </Section>

          <Section
            title="Склады и роли"
            hint={otherWarehouses
              ? `Роль на каждом складе своя. Ещё складов, которыми вы не управляете: ${otherWarehouses} — они не изменятся.`
              : 'Роль на каждом складе своя'}
          >
            <ul className="divide-y divide-line rounded-2xl border border-line">
              {warehouseIds.map(id => {
                const on = checked.has(id)
                return (
                  <li key={id} className="flex items-center gap-3 px-3 py-2">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      aria-label={whLabel(id)}
                      onClick={() => toggleWarehouse(id)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left text-sm"
                    >
                      <span className={cn('grid size-4 shrink-0 place-items-center rounded-full transition-colors', on ? 'bg-brand text-white' : 'border border-line-strong')}>
                        {on && <Check className="size-3" strokeWidth={3} />}
                      </span>
                      <span className={cn('truncate', on ? 'font-medium' : 'text-muted-foreground')}>{whLabel(id)}</span>
                    </button>
                    {on ? (
                      <Select className="h-8 w-52" value={rights[id].role} onChange={e => patch(id, () => ({ role: e.target.value }))} aria-label={`Роль на складе ${whLabel(id)}`}>
                        {roles.map(r => <option key={r.key} value={r.key}>{r.label}{r.builtin ? '' : ' *'}</option>)}
                      </Select>
                    ) : (
                      <span className="text-xs text-muted-foreground">нет доступа</span>
                    )}
                  </li>
                )
              })}
            </ul>
          </Section>

          {cur && (
            <Section title={checkedList.length > 1 ? 'Разделы и действия на складе' : 'Разделы и действия'} hint="Если разделы не выбраны — как у роли">
              {checkedList.length > 1 && (
                <div className="inline-flex max-w-full flex-wrap gap-0.5 rounded-xl border border-line bg-surface-2 p-0.5">
                  {checkedList.map(id => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setEditWh(id)}
                      className={cn('rounded-[10px] px-3 py-1 text-sm font-medium transition-colors', id === shownWh ? 'bg-surface text-foreground shadow-card' : 'text-muted-foreground hover:text-ink-2')}
                    >
                      {whLabel(id)}
                    </button>
                  ))}
                </div>
              )}
              <ModulesCheckboxGroup
                items={ALL_MODULES}
                labels={VS_MODULE_LABELS}
                selected={cur.modules}
                onToggle={m => patch(shownWh, r => ({ modules: toggleIn(r.modules, m) }))}
                onSetAll={all => patch(shownWh, () => ({ modules: all ? new Set(ALL_MODULES) : new Set() }))}
              />
              <div className="pt-1 text-xs font-medium text-muted-foreground">Действия</div>
              <ModulesCheckboxGroup items={ALL_ACTIONS} labels={VS_ACTION_LABELS} selected={cur.actions} onToggle={a => patch(shownWh, r => ({ actions: toggleIn(r.actions, a) }))} />
            </Section>
          )}

          {emplCompanies.length > 0 && (
            <Section title="Видимые компании" hint="Если ничего не выбрано — видны все">
              <ModulesCheckboxGroup items={emplCompanies} labels={companyLabels} selected={visibleCompanies} onToggle={c => setVisibleCompanies(prev => toggleIn(prev, c))} />
            </Section>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? 'Сохранение…' : 'Сохранить'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
