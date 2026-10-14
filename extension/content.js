// «СберЛогистика в WMS» — разделы robops.ru внутри wwh.samokat.ru.
//
// Что делает:
//  1. Кнопка «СберЛогистика» с меню всех разделов сайта (пока встраивание в
//     само боковое меню WMS не сделано — см. injectIntoWmsMenu ниже).
//  2. Раздел открывается поверх рабочей области WMS во встроенном окне
//     (iframe на robops.ru). Окно одно и не перезагружается при переключении
//     разделов — переход идёт сообщением, как клик по меню сайта.
//  3. WMS-токен из открытой сессии WMS передаётся сайту (разделам, которые
//     сами ходят в WMS: Поставки, Списки ЕО…). Только access-токен — обновляет
//     его сама WMS, а мы пересылаем свежий.
//
// Связь с сайтом — postMessage, см. frontend-app/src/lib/embed.js.

(() => {
  if (window.top !== window.self) return // не внутри чужих фреймов
  if (document.getElementById('zlp-root')) return

  const SITE = 'https://robops.ru'

  // Те же разделы, что в меню сайта (frontend-app/src/components/layout/Sidebar.jsx).
  // Иконки — контуры lucide (как на сайте).
  const SECTIONS = [
    { page: 'stats', label: 'Статистика', icon: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>' },
    { page: 'monitor', label: 'Мониторинг', icon: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>' },
    { page: 'motivation', label: 'Мотивация', icon: '<circle cx="12" cy="8" r="6"/><path d="M15.48 12.89 17 22l-5-3-5 3 1.52-9.11"/>' },
    { page: 'tsd', label: 'Выдача ТСД', icon: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M8 7v10"/><path d="M12 7v10"/><path d="M16 7v10"/>' },
    { page: 'consolidation', label: 'Консолидация', icon: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>' },
    {
      label: 'Комплектация', icon: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
      children: [
        { page: 'picking-piece', label: 'Штучный отбор' },
        { page: 'picking-kdk-layout', label: 'Раскладка КДК' },
        { page: 'picking-kdk', label: 'Зависшие задачи' },
        { page: 'picking-eo', label: 'Поиск ЕО' },
        { page: 'picking-gaps', label: 'Пропуски в отборе' },
      ],
    },
    { page: 'shipments', label: 'Отгрузка', icon: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>' },
    { page: 'supplies', label: 'Поставки', icon: '<path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14"/><path d="m7.5 4.27 9 5.15"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/><circle cx="18.5" cy="15.5" r="2.5"/><path d="M20.27 17.27 22 19"/>' },
    { page: 'reports', label: 'Отчёты', icon: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>' },
    { page: 'stock-consolidation', label: 'Объединение остатков', icon: '<rect width="8" height="8" x="2" y="2" rx="2"/><path d="M14 2c1.1 0 2 .9 2 2v4c0 1.1-.9 2-2 2"/><path d="M20 2c1.1 0 2 .9 2 2v4c0 1.1-.9 2-2 2"/><path d="M10 18H5c-1.7 0-3-1.3-3-3v-1"/><polyline points="7 21 10 18 7 15"/><rect width="8" height="8" x="14" y="14" rx="2"/>' },
    { page: 'violations', label: 'Нарушения', icon: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>' },
    { page: 'settings', label: 'Настройки', icon: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>' },
  ]
  const svg = (paths, size = 18) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
  const ICON_X = '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  const ICON_BACK = '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>'
  const ICON_EXT = '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'
  const ICON_LOGOUT = '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>'
  const ICON_LOGO = '<path d="M22 8.35V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8.35A2 2 0 0 1 3.26 6.5l8-3.2a2 2 0 0 1 1.48 0l8 3.2A2 2 0 0 1 22 8.35Z"/><path d="M6 18h12"/><path d="M6 14h12"/><rect width="12" height="12" x="6" y="10"/>'

  const allPages = SECTIONS.flatMap(s => (s.children ? s.children : [s]))
  const labelOf = page => allPages.find(s => s.page === page)?.label || 'СберЛогистика'

  // ─── Каркас: кнопка + меню + окно с сайтом ────────────────────────────────
  const root = document.createElement('div')
  root.id = 'zlp-root'
  root.innerHTML = `
    <button type="button" class="zlp-launcher" title="Разделы СберЛогистики">
      <span class="zlp-logo">${svg(ICON_LOGO, 16)}</span><span>СберЛогистика</span>
    </button>
    <div class="zlp-menu" hidden></div>
    <div class="zlp-panel" hidden>
      <div class="zlp-panel-bar">
        <button type="button" class="zlp-btn zlp-back" title="Вернуться в WMS">${svg(ICON_BACK, 16)}<span>WMS</span></button>
        <span class="zlp-title"></span>
        <span class="zlp-user" hidden>
          <span class="zlp-avatar"></span><span class="zlp-user-name"></span>
          <button type="button" class="zlp-btn zlp-logout" title="Выйти из учётки СберЛогистики">${svg(ICON_LOGOUT, 16)}<span>Выйти</span></button>
        </span>
        <a class="zlp-btn zlp-open" target="_blank" rel="noopener" title="Открыть в отдельной вкладке">${svg(ICON_EXT, 16)}</a>
        <button type="button" class="zlp-btn zlp-close" title="Закрыть">${svg(ICON_X, 16)}</button>
      </div>
      <iframe class="zlp-frame" title="СберЛогистика" allow="clipboard-write"></iframe>
    </div>`
  document.body.appendChild(root)

  const launcher = root.querySelector('.zlp-launcher')
  const menu = root.querySelector('.zlp-menu')
  const panel = root.querySelector('.zlp-panel')
  const frame = root.querySelector('.zlp-frame')
  const titleEl = root.querySelector('.zlp-title')
  const openLink = root.querySelector('.zlp-open')
  const userBox = root.querySelector('.zlp-user')
  const userName = root.querySelector('.zlp-user-name')
  const userAvatar = root.querySelector('.zlp-avatar')

  let currentPage = null
  let frameReady = false

  function renderMenu() {
    menu.innerHTML = `<div class="zlp-menu-head">${svg(ICON_LOGO, 16)} СберЛогистика</div>` + SECTIONS.map(s => {
      if (s.children) {
        return `<div class="zlp-group"><div class="zlp-item zlp-item-group">${svg(s.icon)}<span>${s.label}</span></div>` +
          s.children.map(c => `<button type="button" class="zlp-item zlp-sub${c.page === currentPage ? ' zlp-active' : ''}" data-page="${c.page}">${c.label}</button>`).join('') +
          '</div>'
      }
      return `<button type="button" class="zlp-item${s.page === currentPage ? ' zlp-active' : ''}" data-page="${s.page}">${svg(s.icon)}<span>${s.label}</span></button>`
    }).join('')
  }

  function open(page) {
    currentPage = page
    titleEl.textContent = labelOf(page)
    openLink.href = `${SITE}/#/${page}`
    if (!frame.src) {
      frame.src = `${SITE}/#/${page}`
    } else if (frameReady) {
      frame.contentWindow.postMessage({ type: 'zlp:navigate', page }, SITE)
    } else {
      frame.src = `${SITE}/#/${page}`
    }
    panel.hidden = false
    menu.hidden = true
    document.documentElement.classList.add('zlp-open')
    sendToken()
    syncActive()
  }

  function closePanel() {
    panel.hidden = true
    document.documentElement.classList.remove('zlp-open')
    currentPage = null
    syncActive()
  }

  function syncActive() {
    renderMenu()
    window.dispatchEvent(new CustomEvent('zlp:active', { detail: currentPage }))
  }

  launcher.addEventListener('click', () => { renderMenu(); menu.hidden = !menu.hidden })
  menu.addEventListener('click', e => {
    const btn = e.target.closest('[data-page]')
    if (btn) open(btn.dataset.page)
  })
  root.querySelector('.zlp-back').addEventListener('click', closePanel)
  root.querySelector('.zlp-close').addEventListener('click', closePanel)
  // Выход — подтверждение прямо на кнопке (без системного окна браузера):
  // первое нажатие — «Точно выйти?», второе в течение 4 с — выход.
  const logoutBtn = root.querySelector('.zlp-logout')
  const logoutLabel = logoutBtn.querySelector('span')
  let logoutArmed = null
  logoutBtn.addEventListener('click', () => {
    if (!logoutArmed) {
      logoutBtn.classList.add('zlp-armed')
      logoutLabel.textContent = 'Точно выйти?'
      logoutBtn.title = 'Нажмите ещё раз, чтобы выйти из учётки СберЛогистики (WMS это не затронет)'
      logoutArmed = setTimeout(disarm, 4000)
      return
    }
    disarm()
    frame.contentWindow?.postMessage({ type: 'zlp:logout' }, SITE)
  })
  function disarm() {
    clearTimeout(logoutArmed)
    logoutArmed = null
    logoutBtn.classList.remove('zlp-armed')
    logoutLabel.textContent = 'Выйти'
    logoutBtn.title = 'Выйти из учётки СберЛогистики'
  }
  document.addEventListener('click', e => { if (!menu.hidden && !root.contains(e.target)) menu.hidden = true })
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) menu.hidden = true })

  // Сообщения от сайта: готов / какой раздел открыт (переходы внутри сайта)
  window.addEventListener('message', e => {
    if (e.origin !== SITE || e.source !== frame.contentWindow || !e.data) return
    if (e.data.type === 'zlp:ready') { frameReady = true; sendToken(); checkUpdate(e.data.extLatest) }
    if (e.data.type === 'zlp:user') {
      const name = e.data.name
      userBox.hidden = !name
      userName.textContent = name || ''
      userAvatar.textContent = (name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase()
    }
    if (e.data.type === 'zlp:page' && e.data.page && !panel.hidden) {
      currentPage = e.data.page
      titleEl.textContent = labelOf(currentPage)
      openLink.href = `${SITE}/#/${currentPage}`
      syncActive()
    }
  })

  // ─── Обновление расширения ────────────────────────────────────────────────
  // Сайт (во встроенном окне) сообщает актуальную версию; если наша старше —
  // плашка «Доступно обновление» в полосе окна и точка у пункта меню.
  const MY_VERSION = (() => { try { return chrome.runtime.getManifest().version } catch { return '0.0.0' } })()
  const newer = (a, b) => {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
    }
    return false
  }
  let updateAvailable = null
  function checkUpdate(latest) {
    if (!latest || !newer(latest, MY_VERSION)) return
    updateAvailable = latest
    const bar = root.querySelector('.zlp-panel-bar')
    if (!bar.querySelector('.zlp-update')) {
      const a = document.createElement('a')
      a.className = 'zlp-btn zlp-update'
      a.href = `${SITE}/#/extension`
      a.target = '_blank'
      a.rel = 'noopener'
      a.title = `Установлена версия ${MY_VERSION}, доступна ${latest} — откроется страница с инструкцией`
      a.textContent = `Доступно обновление ${latest}`
      titleEl.after(a)
    }
    menuState?.header.classList.add('zlp-has-update')
  }

  // ─── WMS-токен из открытой сессии WMS ─────────────────────────────────────
  // Ищем в хранилищах страницы JWT (eyJ…) с полем exp и берём самый свежий.
  // Ключ, под которым WMS хранит токен, точно неизвестен — поэтому поиск, а
  // не жёсткое имя: работает, пока WMS хранит токен в localStorage/sessionStorage.
  function decodeExp(jwt) {
    try {
      const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
      return typeof payload.exp === 'number' ? payload.exp * 1000 : null
    } catch { return null }
  }
  function findTokens(value, out) {
    if (typeof value !== 'string') return
    for (const m of value.matchAll(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g)) out.push(m[0])
  }
  function findWmsToken() {
    const found = []
    for (const store of [localStorage, sessionStorage]) {
      try {
        for (let i = 0; i < store.length; i++) findTokens(store.getItem(store.key(i)), found)
      } catch { /* хранилище недоступно */ }
    }
    let best = null
    for (const t of found) {
      const exp = decodeExp(t)
      if (exp && exp > Date.now() && (!best || exp > best.exp)) best = { token: t, exp }
    }
    return best
  }

  let lastSent = ''
  function sendToken(force) {
    if (!frame.src || !frame.contentWindow) return
    const t = findWmsToken()
    if (!t) return
    if (!force && t.token === lastSent) return
    lastSent = t.token
    frame.contentWindow.postMessage({ type: 'zlp:wms-token', accessToken: t.token, expiresAt: t.exp }, SITE)
  }
  setInterval(() => sendToken(), 20_000)  // WMS обновляет токен раз в несколько минут
  window.addEventListener('storage', () => sendToken())
  frame.addEventListener('load', () => { frameReady = false; setTimeout(() => sendToken(true), 800) })

  // ─── Пункты в боковом меню WMS ────────────────────────────────────────────
  // Классы в WMS генерируются сборкой и меняются от версии к версии, поэтому
  // меню ищется по самим пунктам: общий предок «Мониторинг» / «Отгрузка» /
  // «Отчёты» — это список меню, а пункт «Отчёты» служит образцом: его копия
  // (с теми же классами WMS) выглядит в точности как родной пункт.
  // После «Отчётов» добавляется сворачиваемый пункт «СберЛогистика» с
  // разделами сайта. React-обработчики при копировании не переносятся —
  // клики ведём сами.
  const ANCHORS = ['Мониторинг', 'Отгрузка', 'Отчёты']
  const LS_GROUP_OPEN = 'zlp-menu-open'
  const NS = 'http://www.w3.org/2000/svg'
  let menuState = null // { container, items: Map(page → el), header, children: [] }

  function elementByOwnText(text) {
    const r = document.evaluate(
      `//*[not(ancestor-or-self::*[@id="zlp-root"])][normalize-space(text())="${text}"]`,
      document.body, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
    return r.singleNodeValue
  }

  function findWmsMenu() {
    const els = ANCHORS.map(elementByOwnText)
    if (els.some(e => !e)) return null
    let container = els[0].parentElement
    while (container && !els.every(e => container.contains(e))) container = container.parentElement
    if (!container || container === document.body) return null
    const itemOf = el => { let n = el; while (n && n.parentElement !== container) n = n.parentElement; return n }
    const reports = itemOf(els[2])
    return reports ? { container, template: reports, label: els[2] } : null
  }

  function makeSvg(paths, like) {
    const s = document.createElementNS(NS, 'svg')
    s.setAttribute('viewBox', '0 0 24 24')
    s.setAttribute('fill', 'none')
    s.setAttribute('stroke', 'currentColor')
    s.setAttribute('stroke-width', '1.75')
    s.setAttribute('stroke-linecap', 'round')
    s.setAttribute('stroke-linejoin', 'round')
    const box = like?.getBoundingClientRect()
    const size = box && box.width ? Math.round(box.width) : 18
    s.setAttribute('width', String(size))
    s.setAttribute('height', String(size))
    if (like?.getAttribute('class')) s.setAttribute('class', like.getAttribute('class'))
    // у WMS иконки залитые, и её класс иконки ставит fill — наши контурные
    // иначе превращаются в чёрные пятна (см. content.css, [data-zlp-icon])
    s.setAttribute('data-zlp-icon', '')
    s.style.fill = 'none'
    s.style.stroke = 'currentColor'
    s.innerHTML = paths
    return s
  }

  /** Копия пункта «Отчёты» с нашим текстом и иконкой. */
  function cloneItem(found, label, iconPaths, { indent = 0, chevron = false } = {}) {
    const el = found.template.cloneNode(true)
    el.setAttribute('data-zlp', '')
    // текст: тот же элемент, что в образце держал «Отчёты»
    const labelPath = []
    for (let n = found.label; n && n !== found.template; n = n.parentElement) labelPath.unshift([...n.parentElement.children].indexOf(n))
    let labelEl = el
    for (const i of labelPath) labelEl = labelEl?.children[i]
    if (labelEl) labelEl.textContent = label
    // иконка
    const oldSvg = el.querySelector('svg')
    if (oldSvg) {
      const svgEl = iconPaths ? makeSvg(iconPaths, found.template.querySelector('svg')) : makeSvg('', found.template.querySelector('svg'))
      if (!iconPaths) svgEl.style.visibility = 'hidden' // у подпунктов — пустое место вместо иконки, как в WMS
      oldSvg.replaceWith(svgEl)
    }
    // ссылки и «текущий пункт» образца нам не нужны (если «Отчёты» сейчас
    // открыты, у образца есть класс активного пункта _isActive_…)
    for (const a of [el, ...el.querySelectorAll('*')]) {
      a.removeAttribute('href')
      a.removeAttribute('aria-current')
      a.removeAttribute('id')
      for (const c of [...a.classList]) if (/isActive/i.test(c)) a.classList.remove(c)
    }
    el.setAttribute('role', 'button')
    el.tabIndex = 0
    el.style.cursor = 'pointer'
    if (indent && labelEl) labelEl.style.marginLeft = `${indent}px`
    if (chevron && labelEl) {
      const ch = makeSvg('<path d="m6 9 6 6 6-6"/>')
      ch.setAttribute('width', '16')
      ch.setAttribute('height', '16')
      ch.classList.add('zlp-chevron')
      labelEl.after(ch)
    }
    return el
  }

  function injectIntoWmsMenu() {
    if (menuState?.container.isConnected && menuState.header.isConnected) return true
    const found = findWmsMenu()
    if (!found) return false
    if (found.container.querySelector('[data-zlp]')) return true

    const items = new Map()
    const children = []
    const header = cloneItem(found, 'СберЛогистика', ICON_LOGO, { chevron: true })
    header.setAttribute('data-zlp-group', '')
    const nodes = [header]
    for (const s of SECTIONS) {
      if (s.children) {
        const key = s.label
        const sub = cloneItem(found, s.label, s.icon, { chevron: true })
        sub.classList.add('zlp-child', 'zlp-menu-subhead')
        sub.dataset.zlpSubgroup = key
        children.push(sub); nodes.push(sub)
        for (const c of s.children) {
          const el = cloneItem(found, c.label, null)
          el.classList.add('zlp-child', 'zlp-child2')
          el.dataset.zlpPage = c.page
          el.dataset.zlpParent = key
          items.set(c.page, el); children.push(el); nodes.push(el)
        }
      } else {
        const el = cloneItem(found, s.label, s.icon)
        el.classList.add('zlp-child')
        el.dataset.zlpPage = s.page
        items.set(s.page, el); children.push(el); nodes.push(el)
      }
    }
    let anchor = found.template
    for (const n of nodes) { anchor.after(n); anchor = n }

    menuState = { container: found.container, header, items, children }
    if (updateAvailable) header.classList.add('zlp-has-update')
    applyGroupOpen(readGroupOpen())
    syncMenuActive()
    trackMenuWidth()
    return true
  }

  function readGroupOpen() {
    try { return localStorage.getItem(LS_GROUP_OPEN) !== '0' } catch { return true }
  }
  // раскрытые подгруппы («Комплектация»): по умолчанию свёрнуты
  const LS_SUB_OPEN = 'zlp-menu-sub-open'
  let subOpen = (() => { try { return new Set(JSON.parse(localStorage.getItem(LS_SUB_OPEN) || '[]')) } catch { return new Set() } })()
  function saveSubOpen() { try { localStorage.setItem(LS_SUB_OPEN, JSON.stringify([...subOpen])) } catch { /* ignore */ } }

  function applyVisibility() {
    if (!menuState) return
    const open = menuState.header.classList.contains('zlp-group-open')
    for (const c of menuState.children) {
      const parent = c.dataset.zlpParent
      c.style.display = open && (!parent || subOpen.has(parent)) ? '' : 'none'
      if (c.dataset.zlpSubgroup) c.classList.toggle('zlp-group-open', subOpen.has(c.dataset.zlpSubgroup))
    }
  }
  function applyGroupOpen(open) {
    if (!menuState) return
    menuState.header.classList.toggle('zlp-group-open', open)
    try { localStorage.setItem(LS_GROUP_OPEN, open ? '1' : '0') } catch { /* ignore */ }
    applyVisibility()
  }
  function toggleSubgroup(key) {
    subOpen.has(key) ? subOpen.delete(key) : subOpen.add(key)
    saveSubOpen()
    applyVisibility()
  }

  // Подсветка открытого раздела — родным классом WMS «активный пункт»
  // (_isActive_… на ссылке), а не своими стилями: выглядит в точности как в
  // WMS. Пока открыт наш раздел, с пункта WMS эта пометка снята (иначе горели
  // бы два пункта), при закрытии — возвращается.
  let wmsActiveClass = null
  let strippedWmsActive = []
  function findWmsActiveClass() {
    if (wmsActiveClass || !menuState) return wmsActiveClass
    const el = menuState.container.querySelector('[class*="isActive"]:not([data-zlp] *)')
    wmsActiveClass = el ? [...el.classList].find(c => /isActive/i.test(c)) || null : null
    return wmsActiveClass
  }
  function syncMenuActive() {
    if (!menuState) return
    const parent = currentPage && menuState.items.get(currentPage)?.dataset.zlpParent
    if (parent && !subOpen.has(parent)) { subOpen.add(parent); saveSubOpen(); applyVisibility() }
    for (const c of menuState.children) {
      if (c.dataset.zlpSubgroup) c.classList.toggle('zlp-sub-has-active', c.dataset.zlpSubgroup === parent)
    }
    const cls = findWmsActiveClass()
    for (const [page, el] of menuState.items) {
      const on = page === currentPage
      const link = el.querySelector('a') || el
      if (cls) link.classList.toggle(cls, on)
      else el.classList.toggle('zlp-wms-active', on) // класс WMS не нашли — свои стили
    }
    menuState.header.classList.toggle('zlp-wms-active-group', !!currentPage)
    if (cls && currentPage) {
      for (const el of menuState.container.querySelectorAll('.' + CSS.escape(cls))) {
        if (el.closest('[data-zlp]')) continue
        el.classList.remove(cls)
        strippedWmsActive.push(el)
      }
    } else if (!currentPage && strippedWmsActive.length) {
      for (const el of strippedWmsActive) if (el.isConnected) el.classList.add(cls)
      strippedWmsActive = []
    }
  }
  window.addEventListener('zlp:active', syncMenuActive)

  // Окно с разделом — справа от меню WMS (меню остаётся на виду)
  let widthObserver = null
  function trackMenuWidth() {
    widthObserver?.disconnect()
    const update = () => {
      if (!menuState?.container.isConnected) return
      const right = Math.round(menuState.container.getBoundingClientRect().right)
      root.style.setProperty('--zlp-left', `${right > 40 && right < window.innerWidth / 2 ? right : 0}px`)
      document.documentElement.classList.toggle('zlp-menu-narrow', menuState.container.getBoundingClientRect().width < 120)
    }
    widthObserver = new ResizeObserver(update)
    widthObserver.observe(menuState.container)
    window.addEventListener('resize', update)
    update()
  }

  // Клики по меню WMS: наши пункты открывают разделы, родные — закрывают окно
  document.addEventListener('click', e => {
    if (!menuState?.container.contains(e.target)) return
    const ours = e.target.closest('[data-zlp]')
    if (!ours) { strippedWmsActive = []; if (!panel.hidden) closePanel(); return }
    e.preventDefault()
    e.stopPropagation()
    if (ours.hasAttribute('data-zlp-group')) applyGroupOpen(!menuState.header.classList.contains('zlp-group-open'))
    else if (ours.dataset.zlpSubgroup) toggleSubgroup(ours.dataset.zlpSubgroup)
    else if (ours.dataset.zlpPage) open(ours.dataset.zlpPage)
  }, true)
  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('[data-zlp]')) { e.preventDefault(); e.target.click() }
  })

  // React перерисовывает меню (сворачивание, переходы) — возвращаем пункты на место
  let scheduled = false
  const observer = new MutationObserver(() => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      if (injectIntoWmsMenu()) root.classList.add('zlp-in-menu')
    })
  })
  observer.observe(document.body, { childList: true, subtree: true })
  if (injectIntoWmsMenu()) root.classList.add('zlp-in-menu')
})()
