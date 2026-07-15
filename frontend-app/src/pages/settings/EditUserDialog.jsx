import { useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { ModulesCheckboxGroup } from './ModulesCheckboxGroup'
import { ALL_MODULES, VS_MODULE_LABELS, ALL_ACTIONS, VS_ACTION_LABELS } from './constants'

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
      name: name.trim(), role, modules: [...modules], actions: [...actions],
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Добавить пользователя' : 'Права и модули'}</DialogTitle>
          <DialogDescription>{isNew ? 'Логин — номер телефона в формате 79161234567' : login}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Логин (номер телефона)</span>
            <Input value={login} onChange={e => setLogin(e.target.value)} disabled={!isNew} placeholder="79161234567" />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">ФИО</span>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Иванов Иван Иванович" />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Роль</span>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              value={role} onChange={e => setRole(e.target.value)}
            >
              {roles.map(r => <option key={r.key} value={r.key}>{r.label}{r.builtin ? '' : ' *'}</option>)}
            </select>
          </label>
          {role === 'manager' && (
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Компании (через запятую)</span>
              <Input value={companies} onChange={e => setCompanies(e.target.value)} placeholder="ООО Компания, ИП Иванов" />
            </label>
          )}
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Пароль (оставьте пустым, чтобы не менять)</span>
            <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Новый пароль..." />
          </label>
          <label className="flex items-center gap-2 text-sm font-normal">
            <Checkbox checked={allowWithoutToken} onCheckedChange={() => setAllowWithoutToken(v => !v)} />
            Разрешить вход без токена WMS
          </label>
          <label className="flex items-center gap-2 text-sm font-normal">
            <Checkbox checked={selfOnly} onCheckedChange={() => setSelfOnly(v => !v)} />
            Видит только свои данные
          </label>
          {emplCompanies.length > 0 && (
            <div className="space-y-1 text-sm">
              <span className="font-medium">Видимые компании <span className="font-normal text-muted-foreground">(если не выбрано — все)</span></span>
              <div className="space-y-1.5 pt-1">
                {emplCompanies.map(c => (
                  <label key={c} className="flex items-center gap-2 font-normal">
                    <Checkbox checked={visibleCompanies.has(c)} onCheckedChange={() => toggleSet(setVisibleCompanies, c)} />
                    {c}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-1.5 text-sm">
            <span className="font-medium">Модули</span>
            <ModulesCheckboxGroup items={ALL_MODULES} labels={VS_MODULE_LABELS} selected={modules} onToggle={m => toggleSet(setModules, m)} />
          </div>
          <div className="space-y-1.5 text-sm">
            <span className="font-medium">Действия</span>
            <ModulesCheckboxGroup items={ALL_ACTIONS} labels={VS_ACTION_LABELS} selected={actions} onToggle={a => toggleSet(setActions, a)} columns={false} />
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
