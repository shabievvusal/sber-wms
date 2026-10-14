// Тёмная тема WMS. В дизайн-системе WMS она уже есть — класс
// .default-dark-theme переопределяет все цветовые переменные (--color-…),
// просто сама WMS его не включает. Мы ставим этот класс на <html>.
//
// Запускается на document_start (до отрисовки), чтобы при загрузке страница
// не мигала белым. Переключатель — в content.js (window.__zlpTheme).

(() => {
  if (window.top !== window.self) return

  const KEY = 'zlp-wms-theme' // 'light' | 'dark' | 'system'
  const DARK_CLASS = 'default-dark-theme'
  const media = window.matchMedia('(prefers-color-scheme: dark)')

  const read = () => {
    try {
      const v = localStorage.getItem(KEY)
      return v === 'dark' || v === 'system' ? v : 'light'
    } catch { return 'light' }
  }
  let mode = read()
  const isDark = () => mode === 'dark' || (mode === 'system' && media.matches)

  function apply() {
    const root = document.documentElement
    const dark = isDark()
    root.classList.toggle(DARK_CLASS, dark)
    root.classList.toggle('zlp-dark', dark)
    root.style.colorScheme = dark ? 'dark' : ''
    window.dispatchEvent(new CustomEvent('zlp:theme', { detail: { mode, dark } }))
  }

  // React WMS может перезаписать class у <html> — возвращаем
  new MutationObserver(() => {
    if (document.documentElement.classList.contains(DARK_CLASS) !== isDark()) apply()
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

  media.addEventListener('change', () => { if (mode === 'system') apply() })
  // смена в другой вкладке WMS
  window.addEventListener('storage', e => { if (e.key === KEY) { mode = read(); apply() } })

  window.__zlpTheme = {
    get mode() { return mode },
    get dark() { return isDark() },
    set(next) {
      mode = next
      try { localStorage.setItem(KEY, next) } catch { /* хранилище недоступно */ }
      apply()
    },
  }
  apply()
})()
