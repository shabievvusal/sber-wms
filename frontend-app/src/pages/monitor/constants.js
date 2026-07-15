// Справочники и пороги — перенесены из оригинала MonitorPage.jsx один в один.

export const IDLE_WORK_MIN = 10 // «в работе», если последняя задача завершена не более N мин назад
export const REFRESH_INTERVAL_MS = 3 * 60 * 1000 // автообновление раз в 3 минуты

export const TASK_TYPE_VARIANT = {
  'КДК': 'info',
  'ХР': 'warning',
  'Паллет': 'purple',
}

// Смены — фиксированные по московскому времени (UTC+3), ночная смена
// перетекает через полночь.
export const SHIFT_DAY_START_HOUR = 9
export const SHIFT_NIGHT_START_HOUR = 21
