import { useEffect, useState } from 'react'

// Тема: 'system' | 'light' | 'dark'. На <html> всегда ставится итоговая
// data-theme="light|dark" (для 'system' — по prefers-color-scheme, с подпиской
// на её смену), чтобы и CSS-токены, и dark:-утилиты Tailwind видели одно и то
// же. Тот же ключ читает inline-скрипт в index.html до первой отрисовки.
const KEY = 'zlp.theme'
const media = () => window.matchMedia('(prefers-color-scheme: dark)')

export function readTheme() {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

function apply(theme) {
  const resolved = theme === 'system' ? (media().matches ? 'dark' : 'light') : theme
  document.documentElement.dataset.theme = resolved
}

export function useTheme() {
  const [theme, setTheme] = useState(readTheme)
  useEffect(() => {
    try { localStorage.setItem(KEY, theme) } catch { /* приватный режим */ }
    apply(theme)
    if (theme !== 'system') return
    const mq = media()
    const onChange = () => apply('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])
  return [theme, setTheme]
}

/** Итоговая тема ('light' | 'dark') — для библиотек со своей темой (sonner). */
export function useResolvedTheme() {
  const get = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
  const [resolved, setResolved] = useState(get)
  useEffect(() => {
    const mo = new MutationObserver(() => setResolved(get()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => mo.disconnect()
  }, [])
  return resolved
}
