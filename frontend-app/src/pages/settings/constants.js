// Перенесено как есть из оригинала (frontend/app/src/pages/settings/SettingsPage.jsx) —
// это справочники прав доступа, а не вёрстка, менять нечего.

export const VS_MODULE_LABELS = {
  stats: 'Статистика', data: 'Данные', monitor: 'Мониторинг',
  analysis: 'Анализ', consolidation: 'Консолидация', docs: 'Документы',
  settings: 'Настройки', shipments: 'Отгрузка',
  receive: 'Форма отгрузки', consolidation_form: 'Форма консолидации',
  reports: 'Отчёты', supplies: 'Поставки',
  picking: 'Комплектация', shift_plan: 'План смены',
  tsd: 'Выдача ТСД', violations: 'Нарушения',
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

export function rolesToLabelMap(roles) {
  const map = {}
  for (const r of roles) map[r.key] = r.label
  return map
}

export function rolesOrBuiltin(roles) {
  return roles.length ? roles : Object.entries(BUILTIN_ROLE_LABELS).map(([key, label]) => ({ key, label, builtin: true }))
}
