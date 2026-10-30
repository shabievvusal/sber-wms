import { whKey } from '@/lib/warehouse'

// Начальники смены — варианты «Составил» в служебных записках консолидации.
// Хранятся в браузере (по складам); задаются в Настройки → Документы.
const STORAGE_KEY = 'memos_supervisors'

export function getSupervisors() {
  try { return JSON.parse(localStorage.getItem(whKey(STORAGE_KEY)) || '[]') } catch { return [] }
}

export function saveSupervisors(arr) {
  localStorage.setItem(whKey(STORAGE_KEY), JSON.stringify(arr))
}
