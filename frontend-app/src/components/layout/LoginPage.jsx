import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { Eye, EyeOff, LogIn, Warehouse } from 'lucide-react'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import * as api from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { Select } from '@/components/ui/select'
import { shortWarehouseName } from '@/lib/warehouse'

// Экран входа в стиле WMS (wms/web/src/supervisor/Auth.tsx): спокойный фон
// страницы, карточка с крупным скруглением, градиентная кнопка, переключатель
// темы в углу. Логика входа/регистрации — прежняя.

function formatPhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '')
  if (digits.startsWith('8')) digits = '7' + digits.slice(1)
  if (digits.length > 0 && !digits.startsWith('7')) digits = '7' + digits
  digits = digits.slice(0, 11)
  if (digits.length === 0 || digits === '7') return ''
  const d = digits.slice(1)
  let res = '+7'
  if (d.length > 0) res += ' (' + d.slice(0, Math.min(3, d.length))
  if (d.length >= 3) {
    res += ') ' + d.slice(3, Math.min(6, d.length))
    if (d.length > 6) {
      res += '-' + d.slice(6, Math.min(8, d.length))
      if (d.length > 8) res += '-' + d.slice(8, 10)
    }
  }
  return res
}

function isPhoneComplete(formatted) {
  return formatted.replace(/\D/g, '').length === 11
}

const inputCls = 'h-11 w-full rounded-xl border border-input bg-surface px-3.5 text-sm text-foreground shadow-card outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-[3px] focus:ring-ring/20'

function FormGroup({ label, children }) {
  return (
    <div className="mb-4">
      <label className="mb-1 block text-sm text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

function PasswordInput({ value, onChange, placeholder, required, autoFocus }) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <input
        className={inputCls}
        style={{ paddingRight: 44 }}
        type={show ? 'text' : 'password'}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        required={required}
        autoFocus={autoFocus}
      />
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        tabIndex={-1}
        aria-label={show ? 'Скрыть пароль' : 'Показать пароль'}
        className="absolute top-1/2 right-1.5 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  )
}

function PhoneInput({ value, onChange, autoFocus, required }) {
  return (
    <input
      className={inputCls}
      type="tel"
      placeholder="+7 (999) 999-99-99"
      value={value}
      onChange={e => onChange(formatPhone(e.target.value))}
      autoFocus={autoFocus}
      required={required}
    />
  )
}

function ErrorBox({ children }) {
  if (!children) return null
  return (
    <div className="mb-3 rounded-2xl bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">
      {children}
    </div>
  )
}

function SubmitButton({ children, disabled }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className="bg-brand-gradient mt-1 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold text-white shadow-card transition-opacity hover:opacity-90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function LoginTab() {
  const { login } = useAuth()
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async e => {
    e.preventDefault()
    setError('')
    if (!isPhoneComplete(phone)) { setError('Введите полный номер телефона (+7 и 10 цифр)'); return }
    setLoading(true)
    const cleanPhone = '+7' + phone.replace(/\D/g, '').slice(-10)
    try {
      await login(cleanPhone, password)
    } catch (err) {
      setError(err.message || 'Ошибка входа')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <FormGroup label="Номер телефона">
        <PhoneInput value={phone} onChange={setPhone} autoFocus required />
      </FormGroup>
      <FormGroup label="Пароль">
        <PasswordInput placeholder="Пароль от WMS или от сайта" value={password} onChange={e => setPassword(e.target.value)} required />
      </FormGroup>
      <ErrorBox>{error}</ErrorBox>
      <SubmitButton disabled={loading}><LogIn size={16} />{loading ? 'Вход...' : 'Войти'}</SubmitButton>
    </form>
  )
}

function RegisterTab() {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [wmsPassword, setWmsPassword] = useState('')
  const [sitePassword, setSitePassword] = useState('')
  const [sitePasswordConfirm, setSitePasswordConfirm] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [warehouses, setWarehouses] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    api.getWarehouses()
      .then(list => setWarehouses((list || []).map(w => ({ ...w, short: shortWarehouseName(w.name) })).sort((a, b) => a.short.localeCompare(b.short, 'ru'))))
      .catch(() => setWarehouses([]))
  }, [])

  const handleSubmit = async e => {
    e.preventDefault()
    setError('')
    if (sitePassword !== sitePasswordConfirm) { setError('Пароли от сайта не совпадают'); return }
    if (sitePassword.length < 6) { setError('Пароль от сайта должен быть не менее 6 символов'); return }
    if (!isPhoneComplete(phone)) { setError('Введите полный номер телефона (+7 и 10 цифр)'); return }
    if (!warehouseId) { setError('Выберите склад, на котором работаете'); return }
    setLoading(true)
    const cleanPhone = '+7' + phone.replace(/\D/g, '').slice(-10)
    try {
      await api.registerVs({ name, phone: cleanPhone, wmsPassword, sitePassword, warehouseId })
      setDone(true)
    } catch (err) {
      setError(err.message || 'Ошибка регистрации')
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <div className="py-5 pb-2 text-center">
        <div className="mx-auto mb-4 flex size-[52px] items-center justify-center rounded-2xl bg-success/12 text-2xl text-success">✓</div>
        <div className="mb-2 text-lg font-bold">Заявка отправлена</div>
        <div className="text-sm leading-relaxed text-muted-foreground">
          Доступ к сайту запрошен. Ожидайте одобрения администратора вашего склада.
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit}>
      <FormGroup label="ФИО">
        <input className={inputCls} type="text" placeholder="Иванов Иван Иванович" value={name} onChange={e => setName(e.target.value)} autoFocus required />
      </FormGroup>
      <FormGroup label="Номер телефона (как в WMS)">
        <PhoneInput value={phone} onChange={setPhone} required />
      </FormGroup>
      <FormGroup label="Склад">
        <Select value={warehouseId} onChange={e => setWarehouseId(e.target.value)} placeholder="Выберите склад" className="w-full" aria-label="Склад">
          {warehouses.map(w => <option key={w.id} value={w.id}>{w.short}</option>)}
        </Select>
        <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Заявку рассмотрит администратор этого склада.
        </div>
      </FormGroup>
      <FormGroup label={<>Пароль от WMS <span className="text-[11px] font-normal text-muted-foreground">(необязательно)</span></>}>
        <PasswordInput placeholder="Пароль от личного кабинета WMS" value={wmsPassword} onChange={e => setWmsPassword(e.target.value)} />
        <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Используется для синхронизации данных с WMS. Может не работать, если нет доступа к мониторингу.
        </div>
      </FormGroup>
      <div className="my-4 h-px bg-line" />
      <FormGroup label="Пароль для сайта">
        <PasswordInput placeholder="Придумайте пароль" value={sitePassword} onChange={e => setSitePassword(e.target.value)} required />
      </FormGroup>
      <FormGroup label="Повторите пароль для сайта">
        <PasswordInput placeholder="Повторите пароль" value={sitePasswordConfirm} onChange={e => setSitePasswordConfirm(e.target.value)} required />
      </FormGroup>
      <ErrorBox>{error}</ErrorBox>
      <SubmitButton disabled={loading}>{loading ? 'Отправка...' : 'Запросить доступ'}</SubmitButton>
    </form>
  )
}

export default function LoginPage() {
  const [tab, setTab] = useState('login')
  const tabs = [{ value: 'login', label: 'Вход' }, { value: 'register', label: 'Регистрация' }]

  return (
    <div className="relative grid min-h-screen place-items-center bg-background px-4 py-10">
      <div className="absolute top-4 right-4"><ThemeToggle id="login-theme" /></div>
      <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 400, damping: 32 }} className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="bg-brand-gradient grid size-11 place-items-center rounded-2xl text-white shadow-card">
            <Warehouse size={21} strokeWidth={2.2} />
          </div>
          <div>
            <div className="text-xl font-semibold tracking-tight">СберЛогистика WMS</div>
            <div className="text-sm text-muted-foreground">Система мониторинга склада</div>
          </div>
        </div>

        <div className="rounded-3xl border border-line bg-card p-6 shadow-card">
          <div className="mb-5 flex rounded-xl border border-line bg-surface-2 p-0.5">
            {tabs.map(t => (
              <button key={t.value} type="button" onClick={() => setTab(t.value)} className={`relative z-10 flex-1 rounded-[10px] py-2 text-sm font-medium transition-colors ${tab === t.value ? 'text-foreground' : 'text-muted-foreground hover:text-ink-2'}`}>
                {tab === t.value && (
                  <motion.span layoutId="login-tab" transition={{ type: 'spring', stiffness: 500, damping: 40 }} className="absolute inset-0 -z-10 rounded-[10px] bg-surface shadow-card" />
                )}
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'login' ? <LoginTab /> : <RegisterTab />}
        </div>
      </motion.div>
    </div>
  )
}
