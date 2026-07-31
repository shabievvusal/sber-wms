// Перенесено из оригинала (PieceSelectionPage.jsx + KdkLayoutPage.jsx) — в
// оригинале эти списки задублированы в обоих файлах дословно (ZONE_OPTIONS/
// TEMP_OPTIONS в PieceSelectionPage ≡ PIECE_SOURCE_ZONES/PIECE_TEMPS в
// KdkLayoutPage) без общего источника правды. Здесь — один общий модуль,
// это не смена поведения, а устранение дрейф-риска, отмеченного при разборе
// оригинала (см. PLAN.md).

export const TEMP_LABELS = {
  LOW_COLD: 'Низкий холод',
  MEDIUM_COLD: 'Средний холод',
  ORDINARY: 'Сухой',
}

export const STATUS_LABELS = {
  PENDING: 'Новое',
  CREATED: 'Ждёт отбора',
  IN_PROGRESS: 'В работе',
  COMPLETED: 'Выполнено',
}

export const DEFAULT_STATUSES = ['COMPLETED', 'CREATED', 'IN_PROGRESS', 'PENDING']

// Статусы ЗАКАЗА (не задания штучного отбора) — PickingGapsPage.jsx.
export const SHIPMENT_ORDER_STATUS_LABELS = {
  WAITING_FOR_PICKING: 'Ждёт комплектации',
  PICKING: 'Комплектация',
}

// UUID зон WMS конкретного окружения — как и в оригинале, зашиты во
// фронтенде (WMS не отдаёт справочник зон отдельным эндпоинтом, которым
// пользуются эти страницы).
export const ZONE_OPTIONS = [
  { id: 'c976ff6d-865c-472c-a754-cee17e93e63d', label: 'Холод' },
  { id: '0b29f9ce-9549-435e-b7c2-ecdd3e937057', label: 'Сухой' },
  { id: '4cdf0cb7-9361-43b6-abd7-cc98f594765b', label: 'Морозилка' },
]

export const TEMP_OPTIONS = [
  { value: 'LOW_COLD', label: TEMP_LABELS.LOW_COLD },
  { value: 'MEDIUM_COLD', label: TEMP_LABELS.MEDIUM_COLD },
  { value: 'ORDINARY', label: TEMP_LABELS.ORDINARY },
]

export const TYPE_LABELS = {
  IMPORT: 'Умный импорт',
  CROSSDOCK: 'Кросс-докинг',
  STORAGE: 'На хранение от поставщика',
  STORAGE_DC: 'На хранение от РЦ',
}

export const IDLE_LIMIT_MS = 5 * 60 * 1000
