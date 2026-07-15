import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import * as api from '@/lib/api'
import { useAuth } from '@/context/AuthContext'

// 1-в-1 визуальный порт оригинального LoginForm.jsx (там CSS-модуль,
// см. LoginForm.module.css) — тот же зелёный градиентный экран, белая
// карточка, переключатель вкладок и стили полей/кнопки, что и в оригинале
// (цвета — те же CSS-переменные --sber-green/--border/--muted-foreground
// и т.д., уже заведённые в index.css этого проекта), просто без CSS-модулей.

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

const inputCls = 'w-full rounded-[6px] border-[1.5px] border-border bg-card px-3.5 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-[var(--sber-green-light)]'

function FormGroup({ label, children }) {
  return (
    <div className="mb-4">
      <label className="mb-1.5 block text-[13px] font-medium text-muted-foreground">{label}</label>
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
        className="absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
    <div className="mb-3 rounded-[6px] border border-[#fecaca] bg-[#fef2f2] px-3.5 py-2.5 text-[13px] text-destructive">
      {children}
    </div>
  )
}

function SubmitButton({ children, disabled }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className="mt-1 min-h-[52px] w-full rounded-[10px] bg-primary text-[15px] font-semibold text-primary-foreground transition-colors hover:bg-[var(--sber-green-dark)] disabled:cursor-not-allowed disabled:opacity-55"
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
      <SubmitButton disabled={loading}>{loading ? 'Вход...' : 'Войти'}</SubmitButton>
    </form>
  )
}

function RegisterTab() {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [wmsPassword, setWmsPassword] = useState('')
  const [sitePassword, setSitePassword] = useState('')
  const [sitePasswordConfirm, setSitePasswordConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  const handleSubmit = async e => {
    e.preventDefault()
    setError('')
    if (sitePassword !== sitePasswordConfirm) { setError('Пароли от сайта не совпадают'); return }
    if (sitePassword.length < 6) { setError('Пароль от сайта должен быть не менее 6 символов'); return }
    if (!isPhoneComplete(phone)) { setError('Введите полный номер телефона (+7 и 10 цифр)'); return }
    setLoading(true)
    const cleanPhone = '+7' + phone.replace(/\D/g, '').slice(-10)
    try {
      await api.registerVs({ name, phone: cleanPhone, wmsPassword, sitePassword })
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
        <div className="mx-auto mb-4 flex size-[52px] items-center justify-center rounded-full bg-[#dcfce7] text-2xl text-[#16a34a]">✓</div>
        <div className="mb-2 text-lg font-bold">Заявка отправлена</div>
        <div className="text-sm leading-relaxed text-muted-foreground">
          Доступ к сайту запрошен. Ожидайте одобрения администратора.
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
      <FormGroup label={<>Пароль от WMS <span className="text-[11px] font-normal text-muted-foreground">(необязательно)</span></>}>
        <PasswordInput placeholder="Пароль от личного кабинета WMS" value={wmsPassword} onChange={e => setWmsPassword(e.target.value)} />
        <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Используется для синхронизации данных с WMS. Может не работать, если нет доступа к мониторингу.
        </div>
      </FormGroup>
      <div className="my-4 h-px bg-border" />
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

  return (
    <div
      className="flex min-h-screen items-center justify-center p-4"
      style={{ background: 'linear-gradient(135deg, var(--sber-green) 0%, var(--sber-green-dark) 100%)' }}
    >
      <div className="w-full max-w-[380px] rounded-2xl bg-card p-10 shadow-[0_20px_60px_rgba(0,0,0,0.2)]">
        <div className="mb-7 flex items-center gap-3">
          <img src="/icon.png" alt="logo" className="size-12 object-contain" />
          <div>
            <div className="text-[17px] font-bold text-foreground">СберЛогистика WMS</div>
            <div className="text-xs text-muted-foreground">Система мониторинга склада</div>
          </div>
        </div>

        <div className="mb-6 flex gap-1 rounded-[10px] bg-muted p-1">
          <button
            type="button"
            onClick={() => setTab('login')}
            className={
              'flex-1 rounded-lg py-2 text-sm font-medium transition-colors ' +
              (tab === 'login' ? 'bg-card font-semibold text-foreground shadow-[0_1px_4px_rgba(0,0,0,0.10)]' : 'text-muted-foreground')
            }
          >
            Вход
          </button>
          <button
            type="button"
            onClick={() => setTab('register')}
            className={
              'flex-1 rounded-lg py-2 text-sm font-medium transition-colors ' +
              (tab === 'register' ? 'bg-card font-semibold text-foreground shadow-[0_1px_4px_rgba(0,0,0,0.10)]' : 'text-muted-foreground')
            }
          >
            Регистрация
          </button>
        </div>

        {tab === 'login' ? <LoginTab /> : <RegisterTab />}
      </div>
    </div>
  )
}
