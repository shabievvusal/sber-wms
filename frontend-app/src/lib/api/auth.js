// Вход, сессия, склады; Настройки → пользователи, роли, заявки на доступ.
import { apiHeaders, credentials, req } from './core.js'

// вход и регистрация — без склада (сессии ещё нет, склад придёт в /me)
export async function loginVs(login, password) {
  return req('/api/vs/auth/login', {
    method: 'POST',
    noWarehouse: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, password }),
  })
}

export async function registerVs(data) {
  return req('/api/vs/auth/register', {
    method: 'POST',
    noWarehouse: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

/** Справочник складов (для формы регистрации — доступен без входа). */
export async function getWarehouses() {
  return req('/api/vs/auth/warehouses')
}

// Не через req() — 401 здесь означает «нет сессии», а не ошибку.
export async function getVsMe() {
  // с выбранным складом: роль и разделы у пользователя на каждом складе свои
  const r = await fetch('/api/vs/auth/me', { credentials, headers: apiHeaders() })
  if (!r.ok) return null
  return r.json()
}

// Сигнал «я на сайте» для «Был в сети» (см. lib/presence.js). Ошибки не важны:
// не дошёл один сигнал — дойдёт следующий через минуту.
export async function pingPresence() {
  try { await fetch('/api/vs/auth/ping', { method: 'POST', credentials }) } catch { /* сеть */ }
}

export async function logoutVs() {
  return req('/api/vs/auth/logout', { method: 'POST' })
}

// Прямой браузерный вызов в api.samokat.ru (не через свой бэкенд — тот же
// приём, что и в оригинале): именно этот WMS access/refresh-токен потом
// используется браузерными fetch'ами (wmsFetch.js) для скачивания реальных
// данных из WMS, серверный путь их не достаёт.
export async function refreshSamokatToken(refreshToken) {
  const r = await fetch('https://api.samokat.ru/wmsin-wwh/auth/refresh', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
  if (!r.ok) throw new Error(`Ошибка обновления токена: ${r.status}`)
  return r.json()
}

export async function getVsAdminUsers() {
  return req('/api/vs/admin/users')
}

export async function putVsAdminUser(login, payload) {
  return req('/api/vs/admin/users', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, ...payload }),
  })
}

export async function deleteVsAdminUser(login) {
  return req(`/api/vs/admin/users/${encodeURIComponent(login)}`, { method: 'DELETE' })
}

export async function getVsAdminRoles() {
  return req('/api/vs/admin/roles')
}

export async function addVsAdminRole(key, label, modules) {
  return req('/api/vs/admin/roles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, label, modules }),
  })
}

export async function updateVsAdminRole(key, label, modules) {
  return req(`/api/vs/admin/roles/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, modules }),
  })
}

export async function deleteVsAdminRole(key) {
  return req(`/api/vs/admin/roles/${encodeURIComponent(key)}`, { method: 'DELETE' })
}

export async function getVsAdminPending() {
  return req('/api/vs/admin/pending')
}

export async function approveVsPending(phone, role, modules) {
  return req('/api/vs/admin/pending/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, role, modules }),
  })
}

export async function rejectVsPending(phone) {
  return req(`/api/vs/admin/pending/${encodeURIComponent(phone)}`, { method: 'DELETE' })
}
