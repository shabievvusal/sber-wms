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

// На время смены темы CSS-переходы выключены (класс theme-switching, см.
// index.css): иначе каждый элемент с transition-colors (строки таблиц,
// кнопки — на «Статистике» их сотни) анимирует смену цвета, и браузер
// несколько кадров подряд пересчитывает стили всей страницы — переключение
// заметно тормозило (замер: ~420 мс подвисаний против одного кадра ~60 мс).
// Чуть позже, когда новые цвета уже применены, переходы возвращаются.
function apply(theme) {
  const resolved = theme === 'system' ? (media().matches ? 'dark' : 'light') : theme
  const root = document.documentElement
  if (root.dataset.theme === resolved) return
  root.classList.add('theme-switching')
  root.dataset.theme = resolved
  // возвращаем переходы не сразу: это ещё один пересчёт стилей всей страницы,
  // пусть он не идёт вплотную к первому и не мешает анимации переключателя
  clearTimeout(apply.timer)
  apply.timer = setTimeout(() => root.classList.remove('theme-switching'), 300)
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
