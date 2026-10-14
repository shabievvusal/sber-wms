// Статусы проверки учёток ТСД (см. backend AccountCheckService.cs) — подписи,
// цвета и что считать «проблемой» — общие для таблицы сотрудников и отчёта.

export const ACCOUNT_STATUS = {
  ok: { label: 'Работает', short: 'работает', tone: 'good', problem: false },
  auth_failed: { label: 'Не пускает', short: 'не пускает', tone: 'bad', problem: true },
  wms_error: { label: 'Ошибка WMS', short: 'ошибка WMS', tone: 'bad', problem: true },
  no_credentials: { label: 'Нет данных для входа', short: 'нет данных', tone: 'warn', problem: true },
  unavailable: { label: 'Не удалось проверить', short: 'не проверено', tone: 'muted', problem: false },
}

export const UNCHECKED = { label: 'Не проверялась', short: 'не проверялась', tone: 'muted', problem: false }

export const statusMeta = check => (check ? ACCOUNT_STATUS[check.status] || { ...UNCHECKED, label: check.status } : UNCHECKED)

export const isProblem = check => !!check && !!ACCOUNT_STATUS[check.status]?.problem

/** Текст причины для подсказки и отчёта. */
export function statusReason(check) {
  if (!check) return ''
  if (check.status === 'wms_error') return [check.code, check.message].filter(Boolean).join(' — ')
  return check.message || ''
}

export function fmtChecked(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}
