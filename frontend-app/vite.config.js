import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// Отдельный дев-сервер (5174), чтобы работать одновременно с zlp-main-main/frontend/app (5173).
// Проксирует на Caddy бэкенд-песочницы `new zlp-backend` (docker-compose,
// хостовый порт — см. new zlp-backend/.env, PORT) — данные настоящие, не
// моки. Раньше указывал на оригинальный Node-бэкенд (zlp-main-main/backend) —
// переключено, когда `/api/vs/auth/*` полностью переехал на новый ASP.NET
// Core бэкенд (Трек 2, Фаза 4), иначе логин/логаут бил бы не в тот стек.
// Порт в .env менялся (3007 → 3009, под внешнюю панель управления) — если
// поменяется ещё раз, поправить и здесь (или выставить BACKEND_PORT).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    port: 5174,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.BACKEND_PORT || 3009}`,
        changeOrigin: true,
      },
      '/rk-photos': {
        target: `http://127.0.0.1:${process.env.BACKEND_PORT || 3009}`,
        changeOrigin: true,
      },
    },
  },
})
