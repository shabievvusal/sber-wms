// Перенесено как есть из оригинала (frontend/app/src/pages/settings/SettingsPage.jsx) —
// это справочники прав доступа, а не вёрстка, менять нечего.

export const VS_MODULE_LABELS = {
  stats: 'Статистика', data: 'Данные', monitor: 'Мониторинг',
  consolidation: 'Консолидация',
  settings: 'Настройки', shipments: 'Отгрузка',
  receive: 'Форма отгрузки', consolidation_form: 'Форма консолидации',
  reports: 'Отчёты', supplies: 'Поставки',
  picking: 'Комплектация',
  tsd: 'Выдача ТСД', violations: 'Нарушения',
  stock_consolidation: 'Объединение остатков',
  motivation: 'Мотивация',
}
export const ALL_MODULES = Object.keys(VS_MODULE_LABELS)

export const VS_ACTION_LABELS = {
  fetch_data: 'Обновить данные',
  recheck_data: 'Перепроверить данные',
  request_fetch: 'Запросить обновление',
  edit_thresholds: 'Редактировать пороги простоев',
}
export const ALL_ACTIONS = Object.keys(VS_ACTION_LABELS)

// Встроенные роли — fallback до загрузки списка ролей с бэкенда.
export const BUILTIN_ROLE_LABELS = {
  admin: 'Администратор', group_leader: 'Руководитель группы',
  supervisor: 'Начальник смены', manager: 'Менеджер',
}

// Роль «разработчик» в списки выбора не входит (выдаётся только на сервере,
// переменной VS_DEVELOPER_LOGINS) — но подписывать её нужно везде.
export const ROLE_LABELS = { ...BUILTIN_ROLE_LABELS, developer: 'Разработчик' }

export function rolesToLabelMap(roles) {
  const map = { ...ROLE_LABELS }
  for (const r of roles) map[r.key] = r.label
  return map
}

export function rolesOrBuiltin(roles) {
  return roles.length ? roles : Object.entries(BUILTIN_ROLE_LABELS).map(([key, label]) => ({ key, label, builtin: true }))
}
