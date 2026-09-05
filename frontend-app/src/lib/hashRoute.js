// Минимальный «роутер» на location.hash — специально для того, чтобы у строк
// поставок был настоящий href (правая кнопка → «Открыть в новой вкладке» /
// «Копировать ссылку» работает нативно в браузере), раз в песочнице нет
// react-router. Формат: "#/<page>", "#/<page>/<id>" или "#/<page>/<id>/<sub>".
//
// Третий сегмент (`sub`) появился для «Списка ЕО» на странице приёмки: там
// адрес должен указывать и на шаг (`id` = тип операции), и на конкретный
// маршрут (`sub` = routeId), чтобы после перезагрузки кладовщик попадал
// сразу в свой маршрут, а не начинал с выбора операции.
export function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const [page, id, sub] = raw.split('/')
  return {
    page: page ? decodeURIComponent(page) : 'stats',
    id: id ? decodeURIComponent(id) : null,
    sub: sub ? decodeURIComponent(sub) : null,
  }
}

export function hashFor(page, id, sub) {
  if (id && sub) return `#/${page}/${encodeURIComponent(id)}/${encodeURIComponent(sub)}`
  return id ? `#/${page}/${encodeURIComponent(id)}` : `#/${page}`
}

export function setHash(page, id, sub) {
  window.location.hash = hashFor(page, id, sub)
}
