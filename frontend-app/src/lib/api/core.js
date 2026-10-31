// Общее: заголовки запроса (встроенный режим, склад) и req() — fetch к своему бэкенду с разбором JSON и ошибок.
import { isEmbedded } from '@/lib/embed'
import { getWarehouseId } from '@/lib/warehouse'

export const credentials = 'include'

// во встроенном в WMS режиме сервер ставит cookie входа для iframe (см. lib/embed.js)
const embedHeaders = isEmbedded ? { 'X-Embed': '1' } : {}

/** Заголовки каждого запроса к своему серверу: встроенный режим + выбранный
 *  склад (сервер отдаёт данные только этого склада, см. lib/warehouse.js). */
export function apiHeaders(extra, { noWarehouse = false } = {}) {
  const wh = noWarehouse ? null : getWarehouseId()
  return { ...embedHeaders, ...(wh ? { 'X-Warehouse': wh } : {}), ...(extra || {}) }
}

export async function req(url, { noWarehouse, ...opts } = {}) {
  const r = await fetch(url, { credentials, ...opts, headers: apiHeaders(opts.headers, { noWarehouse }) })
  const text = await r.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error(`Сервер вернул не JSON (${r.status}): ${text.slice(0, 150)}`)
  }
  if (!r.ok) throw new Error(data?.error || r.statusText || `HTTP ${r.status}`)
  return data
}
