import { useEffect, useState } from 'react'

// Текущий склад (РЦ). Данные каждого склада на сайте отдельно: выбранный
// склад уходит с каждым запросом к серверу заголовком X-Warehouse (см.
// lib/api.js), сервер проверяет, что он пользователю доступен.
//
// Список доступных складов приходит в /api/vs/auth/me (user.warehouses).
// Выбор запоминается в этом браузере.

const KEY = 'zlp.warehouse'
// СПБ-3 — склад, для которого сайт делался изначально: все данные,
// накопленные до разделения по складам, — его
export const DEFAULT_WAREHOUSE_ID = '0087831f-9906-11ee-8861-08c0eb32014b'

const read = () => { try { return localStorage.getItem(KEY) || null } catch { return null } }
let current = read()
const listeners = new Set()

/** id выбранного склада — для заголовка запросов. */
export function getWarehouseId() { return current }

// идёт смена склада (страница перезагружается) — выбор больше не трогаем:
// до перезагрузки React ещё успевает перерисоваться и вернул бы старый склад
let switching = false

export function setWarehouseId(id) {
  if (switching || !id || id === current) return
  current = id
  try { localStorage.setItem(KEY, id) } catch { /* приватный режим */ }
  for (const fn of listeners) fn(id)
}

/** Ключ браузерного хранилища для данных склада (реквизиты, начальники
 *  смен, зоны, ручные данные отчётов): у СПБ-3 — прежний ключ (ничего не
 *  теряется), у остальных — с id склада. */
export function whKey(key) {
  return !current || current === DEFAULT_WAREHOUSE_ID ? key : `${key}@${current}`
}

/** Сменить склад: роль, разделы и данные на каждом складе свои — страница
 *  перезагружается и получает их заново (/api/vs/auth/me с новым складом). */
export function switchWarehouse(id) {
  if (!id || id === current) return
  setWarehouseId(id)
  switching = true
  window.location.reload()
}

/** «РЦ СБЛ  СПБ-3» → «СПБ-3», «РЦ СБЛ ВЛГ-2 WMS» → «ВЛГ-2». */
export function shortWarehouseName(name) {
  return String(name || '').replace(/^\s*РЦ\s+СБЛ\s+/i, '').replace(/\s+WMS\s*$/i, '').replace(/\s+/g, ' ').trim() || String(name || '')
}

/** Какой склад выбрать для пользователя: тот, для которого сервер отдал
 *  права; иначе запомненный, если он ещё доступен, иначе СПБ-3, иначе первый. */
function pick(user) {
  const list = user?.warehouses || []
  // склад, для которого сервер отдал роль и разделы (/me) — с ним и работаем
  if (user?.warehouseId && list.some(w => w.id === user.warehouseId)) return user.warehouseId
  if (list.some(w => w.id === current)) return current
  const def = user?.defaultWarehouseId || DEFAULT_WAREHOUSE_ID
  if (list.some(w => w.id === def)) return def
  return list[0]?.id || null
}

/** Склад для вошедшего пользователя: { id, warehouse, list, set }.
 *  Сам выправляет выбор, если запомненный склад пользователю недоступен. */
export function useWarehouse(user) {
  // выправляем сразу, при первой отрисовке: страницы шлют первые запросы
  // в своих эффектах, а они срабатывают раньше эффектов родителя
  const [id, setId] = useState(() => {
    const fixed = pick(user)
    if (fixed) setWarehouseId(fixed)
    return fixed
  })
  useEffect(() => {
    const fixed = pick(user)
    if (fixed && fixed !== current) setWarehouseId(fixed)
    setId(fixed)
  }, [user])
  useEffect(() => {
    const fn = next => setId(next)
    listeners.add(fn)
    return () => listeners.delete(fn)
  }, [])
  const list = user?.warehouses || []
  return { id, warehouse: list.find(w => w.id === id) || null, list, set: setWarehouseId }
}
