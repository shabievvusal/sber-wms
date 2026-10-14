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

/** Порты VsUserEditModal оригинала — те же поля, тот же payload на putVsAdminUser. */
export function EditUserDialog({ user, open, onOpenChange, roles, emplCompanies = [], onSaved }) {
  const isNew = !user?.login
  const [login, setLogin] = useState(user?.login || '')
  const [name, setName] = useState(user?.name || '')
  const [role, setRole] = useState(user?.role || 'manager')
  const [companies, setCompanies] = useState((user?.companyIds || []).join(', '))
  const [allowWithoutToken, setAllowWithoutToken] = useState(!!user?.allowWithoutToken)
  const [selfOnly, setSelfOnly] = useState(!!user?.selfOnly)
  const [visibleCompanies, setVisibleCompanies] = useState(() => new Set(user?.visibleCompanies || []))
  const [password, setPassword] = useState('')
  const [modules, setModules] = useState(() => new Set(user?.modules || []))
  const [actions, setActions] = useState(() => new Set(user?.actions || []))
  const [saving, setSaving] = useState(false)

  const toggleSet = (setFn, key) => setFn(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })

  const handleSave = async () => {
    const trimmedLogin = login.trim()
    if (!trimmedLogin) { toast.error('Введите логин (номер)'); return }
    const companyIds = role === 'manager' ? companies.split(/[,;]/).map(x => x.trim()).filter(Boolean) : []
    const payload = {
      name: name.trim(), role, modules: knownModules([...modules]), actions: [...actions],
      companyIds, visibleCompanies: [...visibleCompanies], allowWithoutToken, selfOnly,
    }
    if (password.trim()) payload.password = password.trim()

    setSaving(true)
    try {
      await api.putVsAdminUser(trimmedLogin, payload)
      toast.success('Сохранено')
      onSaved({ login: trimmedLogin, ...payload, hasAccess: true })
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
              <Field label="Роль">
                <Select className="w-full" value={role} onChange={e => setRole(e.target.value)}>
                  {roles.map(r => <option key={r.key} value={r.key}>{r.label}{r.builtin ? '' : ' *'}</option>)}
                </Select>
              </Field>
              <Field label="Пароль" hint="Оставьте пустым, чтобы не менять">
                <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Новый пароль" />
              </Field>
              {role === 'manager' && (
                <Field label="Компании менеджера" hint="Через запятую" className="sm:col-span-2">
                  <Input value={companies} onChange={e => setCompanies(e.target.value)} placeholder="ООО Компания, ИП Иванов" />
                </Field>
              )}
            </div>
            <div className="space-y-3 rounded-2xl bg-surface-2/60 p-3.5">
              <SwitchRow label="Вход без токена WMS" desc="Можно войти только с паролем сайта" checked={allowWithoutToken} onChange={setAllowWithoutToken} />
              <SwitchRow label="Только свои данные" desc="Видит статистику только по себе" checked={selfOnly} onChange={setSelfOnly} />
            </div>
          </Section>

          <Section title="Разделы">
            <ModulesCheckboxGroup
              items={ALL_MODULES}
              labels={VS_MODULE_LABELS}
              selected={modules}
              onToggle={m => toggleSet(setModules, m)}
              onSetAll={all => setModules(all ? new Set(ALL_MODULES) : new Set())}
            />
          </Section>

          <Section title="Действия">
            <ModulesCheckboxGroup items={ALL_ACTIONS} labels={VS_ACTION_LABELS} selected={actions} onToggle={a => toggleSet(setActions, a)} />
          </Section>

          {emplCompanies.length > 0 && (
            <Section title="Видимые компании" hint="Если ничего не выбрано — видны все">
              <ModulesCheckboxGroup items={emplCompanies} labels={companyLabels} selected={visibleCompanies} onToggle={c => toggleSet(setVisibleCompanies, c)} />
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
