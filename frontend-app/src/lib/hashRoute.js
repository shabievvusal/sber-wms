// Минимальный «роутер» на location.hash — специально для того, чтобы у строк
// поставок был настоящий href (правая кнопка → «Открыть в новой вкладке» /
// «Копировать ссылку» работает нативно в браузере), раз в песочнице нет
// react-router. Формат: "#/<page>" или "#/<page>/<id>".
export function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const [page, id] = raw.split('/')
  return { page: page || 'shipments', id: id || null }
}

export function hashFor(page, id) {
  return id ? `#/${page}/${id}` : `#/${page}`
}

export function setHash(page, id) {
  window.location.hash = hashFor(page, id)
}
