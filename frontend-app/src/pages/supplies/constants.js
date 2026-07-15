// Справочники статусов/типов поставок — перенесены из оригинала (текст и
// порядок статусов из frontend/app/src/pages/supplies/SuppliesPage.jsx один в
// один), где были продублированы и в SuppliesPage.jsx, и в SupplyDetailPage.jsx;
// здесь один общий модуль вместо копии.

export const ALL_STATUSES = [
  'TRANSPORTATION_NOT_ASSIGNED', 'AWAITING_GATE', 'AWAITING_ACCEPTANCE',
  'ACCEPTANCE_IN_PROGRESS', 'NOT_VERIFIED', 'CANCELLED',
  'COMPLETED_AS_PLANNED', 'COMPLETED_WITH_DISCREPANCY',
]

export const STATUS_LABELS = {
  TRANSPORTATION_NOT_ASSIGNED: 'Не привязано',
  AWAITING_GATE: 'Ждёт ворот',
  AWAITING_ACCEPTANCE: 'Ждёт приёмку',
  ACCEPTANCE_IN_PROGRESS: 'Приёмка',
  NOT_VERIFIED: 'Не проверено',
  CANCELLED: 'Отменено',
  COMPLETED_AS_PLANNED: 'Принято',
  COMPLETED_WITH_DISCREPANCY: 'Расхождения',
}

// Цвета — маппинг на ближайшие варианты Badge по факту оригинальных CSS-классов
// (badgeAccepted→success, badgeDiscrepancy→warning, badgeInProgress/
// badgeNotAssigned→info (синий, добавлен в badge.jsx под эти два статуса),
// badgePlanned/badgeDefault→gray).
export const STATUS_VARIANT = {
  TRANSPORTATION_NOT_ASSIGNED: 'info',
  AWAITING_GATE: 'outline',
  AWAITING_ACCEPTANCE: 'outline',
  ACCEPTANCE_IN_PROGRESS: 'info',
  NOT_VERIFIED: 'secondary',
  CANCELLED: 'secondary',
  COMPLETED_AS_PLANNED: 'success',
  COMPLETED_WITH_DISCREPANCY: 'warning',
}

// Статусы, для которых имеет смысл колонка «Кто принял».
export const ACCEPTANCE_RELEVANT_STATUSES = [
  'ACCEPTANCE_IN_PROGRESS', 'NOT_VERIFIED', 'COMPLETED_AS_PLANNED', 'COMPLETED_WITH_DISCREPANCY',
]

// Логический порядок статусов для сортировки колонки «Статус» — не совпадает
// с порядком ALL_STATUSES выше (тот — для списка фильтра); перенесён из
// оригинала один в один (активные → ожидание → завершённые → отменено).
// CROSSDOCK с завершённой приёмкой сортируется по статусу комплектации (60-62).
export const STATUS_SORT_ORDER = {
  ACCEPTANCE_IN_PROGRESS: 0,
  AWAITING_ACCEPTANCE: 1,
  AWAITING_GATE: 2,
  TRANSPORTATION_NOT_ASSIGNED: 3,
  NOT_VERIFIED: 5,
  COMPLETED_AS_PLANNED: 6,
  COMPLETED_WITH_DISCREPANCY: 7,
  CANCELLED: 8,
}

export const PICK_STATUS_SORT_ORDER = { waiting: 60, in_progress: 61, done: 62 }

// Статусы, после которых для CROSSDOCK начинается комплектация (см. также
// колонку «Статус» — для этих двух статусов ячейка показывает пилюлю
// комплектации вместо обычного статуса приёмки).
export const CROSSDOCK_PICK_STATUSES = ['COMPLETED_AS_PLANNED', 'COMPLETED_WITH_DISCREPANCY']

export const TYPE_LABELS = {
  IMPORT: 'Умный импорт',
  CROSSDOCK: 'Кросс-докинг',
  STORAGE: 'На хранение от поставщика',
  STORAGE_DC: 'На хранение от РЦ',
}

export const TEMP_LABELS = {
  ORDINARY: 'Сухой',
  MEDIUM_COLD: 'Средний холод',
  LOW_COLD: 'Низкий холод',
}

// Комплектация после приёмки — только для CROSSDOCK (см. PLAN.md: в оригинале
// считается живым сравнением принятого/оставшегося по каждой ЕО через
// отдельный WMS-эндпоинт; здесь захардкожено на моках). Текст и цвета — из
// оригинала (badgePickWaiting/badgeDiscrepancy/badgeAccepted).
export const PICK_STATUS_LABELS = {
  waiting: 'Ждёт комплектацию',
  in_progress: 'Комплектация',
  done: 'Скомплектована',
}

export const PICK_STATUS_VARIANT = {
  waiting: 'outline',
  in_progress: 'warning',
  done: 'success',
}
