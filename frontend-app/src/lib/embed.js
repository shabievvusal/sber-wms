// Режим «сайт встроен в WMS» — расширение для wwh.samokat.ru (папка extension/)
// показывает разделы robops.ru прямо внутри WMS, во встроенном окне (iframe).
//
// Связь с расширением — через postMessage, только с wwh.samokat.ru:
//   WMS → сайт:  { type: 'zlp:wms-token', accessToken, expiresAt }  — токен из открытой сессии WMS
//                { type: 'zlp:navigate', page }                       — открыть раздел
//                { type: 'zlp:logout' }                               — выйти из учётки сайта
//                { type: 'zlp:theme', theme: 'light'|'dark' }          — тема WMS (сайт подстраивается)
//   сайт → WMS:  { type: 'zlp:ready', extLatest }                     — сайт готов + актуальная версия расширения
//                { type: 'zlp:page', page }                           — какой раздел сейчас открыт
//                { type: 'zlp:user', name, role } | { type: 'zlp:user', name: null } — кто вошёл
//
// Берём только access-токен: refresh-токен WMS сайт не трогает, иначе
// обновление токена отсюда могло бы «выкинуть» пользователя из самой WMS.
// Свежий токен расширение присылает само, когда WMS его обновит.

import { setThemeExternal } from './theme'

export const WMS_ORIGIN = 'https://wwh.samokat.ru'

// подставляется плагином сборки (frontend-app/extension-bundle.js)
// eslint-disable-next-line no-undef
export const EXT_VERSION = typeof __EXT_VERSION__ !== 'undefined' ? __EXT_VERSION__ : '0.0.0'

export const isEmbedded = (() => {
  try { return window.self !== window.top } catch { return true }
})()

const LS_ACCESS_KEY = 'wms_access_token'
const LS_ACCESS_EXPIRY_KEY = 'wms_access_token_expiry'

function postToWms(msg) {
  if (!isEmbedded) return
  try { window.parent.postMessage(msg, WMS_ORIGIN) } catch { /* окно WMS закрыто */ }
}

/** Сообщить расширению, кто вошёл на сайт (null — никто): у окна раздела в
 *  WMS своя полоса с именем и кнопкой «Выйти» — меню сайта там скрыто. */
export function postEmbedUser(user) {
  postToWms({ type: 'zlp:user', name: user ? (user.name || user.login || 'Без имени') : null, role: user?.role || null })
}

let logoutHandler = null
/** Как выйти по просьбе расширения (вызывается из AppShell, где есть logout). */
export function setEmbedLogout(fn) { logoutHandler = fn }

export function initEmbedBridge({ onNavigate } = {}) {
  if (!isEmbedded) return () => {}
  document.documentElement.dataset.embedded = '1'

  const onMessage = e => {
    if (e.origin !== WMS_ORIGIN || !e.data || typeof e.data !== 'object') return
    const d = e.data
    if (d.type === 'zlp:wms-token' && typeof d.accessToken === 'string' && d.accessToken) {
      try {
        localStorage.setItem(LS_ACCESS_KEY, d.accessToken)
        localStorage.setItem(LS_ACCESS_EXPIRY_KEY, String(Number(d.expiresAt) || Date.now() + 4 * 60_000))
      } catch { /* хранилище недоступно */ }
    } else if (d.type === 'zlp:navigate' && typeof d.page === 'string') {
      onNavigate?.(d.page)
    } else if (d.type === 'zlp:theme' && (d.theme === 'light' || d.theme === 'dark')) {
      setThemeExternal(d.theme)
    } else if (d.type === 'zlp:logout') {
      logoutHandler?.()
    }
  }
  window.addEventListener('message', onMessage)

  const notifyPage = () => {
    const page = window.location.hash.replace(/^#\/?/, '').split('/')[0] || 'stats'
    postToWms({ type: 'zlp:page', page })
  }
  window.addEventListener('hashchange', notifyPage)
  // актуальная версия расширения (из extension/manifest.json при сборке сайта) —
  // расширение сравнит со своей и покажет «Доступно обновление»
  postToWms({ type: 'zlp:ready', extLatest: EXT_VERSION })
  notifyPage()

  return () => {
    window.removeEventListener('message', onMessage)
    window.removeEventListener('hashchange', notifyPage)
  }
}
