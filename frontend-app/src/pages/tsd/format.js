// Перенесено из TsdIssuePage.jsx оригинала. normalizeScannerCode — самая
// хрупкая часть: если сканер настроен как US-раскладка клавиатуры, а в ОС
// активна русская раскладка, символы сканируются как кириллица-двойники
// латиницы того же физического ряда клавиш — таблица ниже транслитерирует их
// обратно посимвольно, не трогая остальное.

const RU_TO_EN_KEYBOARD = {
  й: 'q', ц: 'w', у: 'e', к: 'r', е: 't', н: 'y', г: 'u', ш: 'i', щ: 'o', з: 'p', х: '[', ъ: ']',
  ф: 'a', ы: 's', в: 'd', а: 'f', п: 'g', р: 'h', о: 'j', л: 'k', д: 'l', ж: ';', э: "'",
  я: 'z', ч: 'x', с: 'c', м: 'v', и: 'b', т: 'n', ь: 'm', б: ',', ю: '.', ё: '`',
  Й: 'Q', Ц: 'W', У: 'E', К: 'R', Е: 'T', Н: 'Y', Г: 'U', Ш: 'I', Щ: 'O', З: 'P', Х: '{', Ъ: '}',
  Ф: 'A', Ы: 'S', В: 'D', А: 'F', П: 'G', Р: 'H', О: 'J', Л: 'K', Д: 'L', Ж: ':', Э: '"',
  Я: 'Z', Ч: 'X', С: 'C', М: 'V', И: 'B', Т: 'N', Ь: 'M', Б: '<', Ю: '>', Ё: '~',
}

export function normalizeScannerCode(raw) {
  return String(raw || '').trim().replace(/[а-яёА-ЯЁ]/g, ch => RU_TO_EN_KEYBOARD[ch] || ch)
}

/** Бейджи сотрудников кодируют `EMP:<executorId>` */
export function extractEmployeeCode(raw) {
  const value = normalizeScannerCode(raw)
  if (!value) return ''
  return value.startsWith('EMP:') ? value.slice(4).trim() : value
}

export function employeeCode(executorId) {
  return executorId ? `EMP:${executorId}` : ''
}

export function formatTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** "Иванов Иван Иванович" → "Иванов И.И." */
export function shortFio(name) {
  if (!name) return '—'
  const parts = String(name).trim().split(/\s+/)
  if (parts.length < 2) return name
  const last = parts[0]
  const initials = parts.slice(1).map(p => p[0] ? p[0].toUpperCase() + '.' : '').join('')
  return last + ' ' + initials
}
