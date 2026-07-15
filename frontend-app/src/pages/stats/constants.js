// Перенесено из оригинала (frontend/app/src/pages/stats/*, utils/statsCalc.js)
// — константы главной страницы «Статистика».

// Зоны склада — НЕ хардкодятся здесь (уточнение пользователя 2026-07-12:
// «без хардкода добавлять новые зоны, название и цвета»). Список зон,
// подписи и цвета собираются из фактических данных на лету —
// см. `zoneLabel`/`zoneColor`/`buildZoneCatalog` в `format.js`.

// Ключи часовых «бакетов» — НЕ сырой час завершения операции, а
// `col = (hour + 1) % 24`. Уточнение пользователя (2026-07-12): день реально
// работает 9:00–21:00 (12 часов, бакеты 10..21), ночь 21:00–9:00 (12 часов,
// бакеты 22..9) — чистое разбиение 12+12 без пересечения на границе (без
// «лишнего» бакета 22 у дня/10 у ночи).
export const DAY_HOURS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]
export const NIGHT_HOURS = [22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

export const OPERATIONS = [
  { value: 'selection', label: 'Комплектация' },
  { value: 'placement', label: 'Размещение' },
  { value: 'receiving', label: 'Приёмка' },
  { value: 'remains', label: 'Остатки' },
]

// «Сотрудники по часам» — 4 режима, как в оригинале. Оригинал ещё содержит
// полностью закодированную, но нигде не подключённую ветку `mode === 'zones'`
// (матрица зона×сотрудник); её сначала подключили пятой кнопкой (решение от
// 2026-07-12), но затем пользователь отменил это решение («матрица зон не
// нужна») — убрана и кнопка, и код режима.
export const HE_MODES = [
  { key: 'sz', label: 'По СЗ' },
  { key: 'hourly', label: 'По зонам' },
  { key: 'monthly', label: 'За период' },
  { key: 'idles', label: 'Простои' },
]

export const IDLE_THRESHOLD_DEFAULT = 15
export const ALLOWED_IDLE_DEFAULT = 10
export const SHIFT_MINUTES = 12 * 60

export const LS_IDLE_THRESHOLD = 'stats_idle_threshold_minutes'
export const LS_ALLOWED_IDLE = 'stats_allowed_idle_minutes'
export const LS_HE_MODE = 'stats_he_table_mode'

// Действия тулбара, гейтятся по роли (не по модулю) — дословно из оригинала
// (backend/vs-auth.js, `ACTIONS_BY_ROLE`), проверяются по роли реального
// вошедшего пользователя (useAuth().user.role).
export const ACTIONS_BY_ROLE = {
  admin: ['fetch_data', 'recheck_data', 'request_fetch', 'edit_thresholds'],
  group_leader: ['fetch_data', 'recheck_data', 'request_fetch', 'edit_thresholds'],
  supervisor: ['fetch_data', 'recheck_data', 'request_fetch'],
  manager: [],
  developer: ['fetch_data', 'recheck_data', 'request_fetch', 'edit_thresholds'],
}
export const ROLE_LABELS = {
  admin: 'Администратор', group_leader: 'Руководитель группы', supervisor: 'Начальник смены',
  manager: 'Менеджер', developer: 'Разработчик',
}
