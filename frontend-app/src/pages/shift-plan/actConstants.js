// Редактируемые константы Акта учёта времени (Настройки → Документы) —
// та же localStorage-модель, что и sz_company_full_names (DocsCard.jsx):
// без бэкенда, правится один раз админом, дальше используется во всех актах.
const LS_ACT_CONSTANTS = 'sz_act_constants'

export const DEFAULT_ACT_CONSTANTS = {
  customerName: 'ООО "Сберлогистика"',
  warehouseAddress: 'г. Санкт-Петербург, п. Шушары. Московское шоссе, 26',
  warehouseType: 'Холодный склад',
  warehouseCategory: 'FMCG',
}

export function loadActConstants() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_ACT_CONSTANTS) || '{}')
    return { ...DEFAULT_ACT_CONSTANTS, ...saved }
  } catch {
    return { ...DEFAULT_ACT_CONSTANTS }
  }
}

export function saveActConstants(constants) {
  try { localStorage.setItem(LS_ACT_CONSTANTS, JSON.stringify(constants)) } catch { /* ignore */ }
}

// sz_company_full_names — {[краткое название]: "ООО \"...\""}, тот же ключ,
// что уже используется в consolidation-reports.js:resolveOfficialName.
export function loadCompanyFullNames() {
  try { return JSON.parse(localStorage.getItem('sz_company_full_names') || '{}') } catch { return {} }
}
