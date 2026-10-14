// Режим «сайт встроен в WMS» — расширение для wwh.samokat.ru (папка extension/)
// показывает разделы robops.ru прямо внутри WMS, во встроенном окне (iframe).
//
// Связь с расширением — через postMessage, только с wwh.samokat.ru:
//   WMS → сайт:  { type: 'zlp:wms-token', accessToken, expiresAt }  — токен из открытой сессии WMS
//                { type: 'zlp:navigate', page }                       — открыть раздел
//   сайт → WMS:  { type: 'zlp:ready' }, { type: 'zlp:page', page }    — какой раздел сейчас открыт
//
// Берём только access-токен: refresh-токен WMS сайт не трогает, иначе
// обновление токена отсюда могло бы «выкинуть» пользователя из самой WMS.
// Свежий токен расширение присылает само, когда WMS его обновит.

export const WMS_ORIGIN = 'https://wwh.samokat.ru'

export const isEmbedded = (() => {
  try { return window.self !== window.top } catch { return true }
})()

const LS_ACCESS_KEY = 'wms_access_token'
const LS_ACCESS_EXPIRY_KEY = 'wms_access_token_expiry'

function postToWms(msg) {
  if (!isEmbedded) return
  try { window.parent.postMessage(msg, WMS_ORIGIN) } catch { /* окно WMS закрыто */ }
}

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
    }
  }
  window.addEventListener('message', onMessage)

  const notifyPage = () => {
    const page = window.location.hash.replace(/^#\/?/, '').split('/')[0] || 'stats'
    postToWms({ type: 'zlp:page', page })
  }
  window.addEventListener('hashchange', notifyPage)
  postToWms({ type: 'zlp:ready' })
  notifyPage()

  return () => {
    window.removeEventListener('message', onMessage)
    window.removeEventListener('hashchange', notifyPage)
  }
}
