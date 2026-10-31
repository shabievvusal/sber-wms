// API-слой сайта: запросы к своему бэкенду (dotnet за Caddy; в разработке —
// proxy в vite.config.js). Функции разложены по разделам в lib/api/*.js,
// здесь — общая точка входа: страницы импортируют `* as api from '@/lib/api'`.
export { apiHeaders } from './api/core.js'
export * from './api/auth.js'
export * from './api/shipments.js'
export * from './api/tsd.js'
export * from './api/settings.js'
export * from './api/supplyPlans.js'
export * from './api/stats.js'
export * from './api/zgz.js'
export * from './api/consolidation.js'
export * from './api/violations.js'
export * from './api/motivation.js'
