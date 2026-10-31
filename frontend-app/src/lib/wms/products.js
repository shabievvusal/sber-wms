// Товары: поиск по ШК, остатки и ЕО товара, кто комплектует из ЕО, веса из карточки WMS.
import { saveWmsWeights } from '@/lib/api'
import { getStoredToken, samokatGet, wmsHeaders } from './core.js'
import { _fetchOnePageFromBrowser } from './stockChanges.js'

const PRODUCTS_SEARCH_URL = 'https://api.samokat.ru/wmsops-wwh/products/search'

const STOCKS_OVERVIEW_URL = 'https://api.samokat.ru/wmsops-wwh/stocks/overview'

// Вес единицы — stocks/overview/{productId} → product.measurements.weight (г).
// Нет productId — сначала products/search по артикулу.

async function findWmsProductId(token, code) {
  const r = await fetch(PRODUCTS_SEARCH_URL, {
    method: 'POST',
    headers: { ...wmsHeaders(token), 'Content-Type': 'application/json', 'X-Who': 'a3327d34-1f6b-46bb-9936-0306ec6c21ad' },
    body: JSON.stringify({ productFilter: { type: 'PRODUCT_NOMENCLATURE_CODE', nomenclatureCode: code }, pageSize: 30, pageNumber: 1 }),
  })
  if (!r.ok) throw new Error(`WMS products/search ${r.status}`)
  const data = await r.json()
  const list = data?.value?.data || []
  return (list.find(p => p.nomenclatureCode === code) || list[0])?.id || null
}

// ШК → товары (products/search, PRODUCT_BARCODE) → остатки товара по ячейкам
// и ЕО (stocks/v2/details). Ворота — ячейки G<номер> («Ворота 147»).
const STOCKS_DETAILS_URL = 'https://api.samokat.ru/wmsops-wwh/stocks/v2/details'

export async function findProductsByBarcode(token, barcode) {
  const r = await fetch(PRODUCTS_SEARCH_URL, {
    method: 'POST',
    headers: { ...wmsHeaders(token), 'Content-Type': 'application/json', 'X-Who': 'a3327d34-1f6b-46bb-9936-0306ec6c21ad' },
    body: JSON.stringify({ productFilter: { type: 'PRODUCT_BARCODE', barcode }, pageSize: 30, pageNumber: 1 }),
  })
  if (!r.ok) throw new Error(`WMS products/search ${r.status}`)
  const data = await r.json()
  return (data?.value?.data || []).map(p => ({ id: p.id, name: p.productName || '', code: p.nomenclatureCode || '', imageUrl: p.imageUrl || '' }))
}

export async function fetchProductStock(token, productId) {
  const size = 100
  const out = []
  for (let pageNumber = 1; pageNumber <= 50; pageNumber++) {
    const r = await fetch(STOCKS_DETAILS_URL, {
      method: 'POST',
      headers: { ...wmsHeaders(token), 'Content-Type': 'application/json', 'X-Who': 'a3327d34-1f6b-46bb-9936-0306ec6c21ad' },
      body: JSON.stringify({
        productId, parts: null, statuses: null, cellId: null, handlingUnitBarcode: null, zoneIds: null, locationIds: null,
        rows: null, sections: null, levels: null, owner: null, sortByQuantity: null, pageNumber, pageSize: size,
      }),
    })
    if (!r.ok) throw new Error(`WMS stocks/v2/details ${r.status}`)
    const data = await r.json()
    const items = data?.value?.items || []
    out.push(...items)
    if (items.length < size || out.length >= (data?.value?.total ?? 0)) break
  }
  return out.map(s => ({
    cell: s.address?.cellAddress || '',
    eo: s.address?.handlingUnitBarcode || '',
    zone: s.location?.zoneName || '',
    location: s.location?.locationName || '',
    status: s.status || '',
    quantity: Number(s.quantity) || 0,
    productionDate: s.part?.productionDate || null,
    bestBeforeDate: s.part?.bestBeforeDate || null,
  }))
}

export async function fetchWmsProductWeight(token, { code, productId }) {
  const id = productId || await findWmsProductId(token, code)
  if (!id) return { productId: null, grams: 0 }
  const data = await samokatGet(token, `${STOCKS_OVERVIEW_URL}/${id}`, '')
  const product = data?.value?.product || {}
  return {
    productId: id,
    grams: Number(product.measurements?.weight) || 0,
    name: product.name || '',
    // штучные штрихкоды и упаковки (коробка: штрихкод + штук в ней) — для «Поиска потеряшек»
    barcodes: product.barcodes || [],
    packages: (data?.value?.packages || []).map(pk => ({ barcode: pk.barcode, qty: Number(pk.quantityInPackage) || 0 })).filter(pk => pk.barcode && pk.qty > 1),
  }
}

// Дозапросить вес у WMS по списку [{ code, name, productId }] и сохранить
// найденное в справочник (пачками — прогресс не теряется при обрыве).
// Токен — свежий на каждую пачку (живёт ~5 минут, AuthContext продлевает).
export async function fillWeightsFromWms(items, { onProgress, shouldStop } = {}) {
  const BATCH = 5
  const SAVE_EVERY = 50
  let pending = []
  let checked = 0, saved = 0
  const notFound = []
  const flush = async () => {
    if (!pending.length) return
    const res = await saveWmsWeights(pending)
    saved += res?.saved ?? pending.length
    pending = []
  }
  for (let i = 0; i < items.length; i += BATCH) {
    if (shouldStop?.()) break
    const token = getStoredToken()
    if (!token) throw new Error('WMS-токен истёк — войдите паролем от WMS')
    const results = await Promise.all(items.slice(i, i + BATCH).map(async it => {
      try { return { it, res: await fetchWmsProductWeight(token, it) } } catch (err) { return { it, err } }
    }))
    for (const { it, res, err } of results) {
      checked++
      const entry = res && { article: it.code, grams: res.grams, productId: res.productId, name: res.name || it.name, barcodes: res.barcodes, packages: res.packages }
      if (res?.grams > 0) pending.push(entry)
      else {
        // веса нет, но штрихкоды/упаковки пригодятся поиску — сохраняем и их
        if (res?.barcodes?.length || res?.packages?.length) pending.push(entry)
        notFound.push({ ...it, reason: err ? err.message : res?.productId ? 'в WMS не указан вес' : 'товар не найден в WMS' })
      }
    }
    if (pending.length >= SAVE_EVERY) await flush()
    onProgress?.({ checked, total: items.length, found: checked - notFound.length, notFound: notFound.length })
  }
  await flush()
  return { checked, saved, notFound }
}

// Кто комплектует из ЕО: последние до 500 операций, где ЕО — источник
// (новые сверху). picked — штук отобрано по этим операциям; pickers —
// сотрудники с числом отборов, последний сверху.
export async function getEoPicking(token, sourceHandlingUnitBarcode) {
  const { items, total } = await _fetchOnePageFromBrowser(token, {
    productId: null, parts: [], operationTypes: [],
    sourceCellId: null, targetCellId: null,
    sourceHandlingUnitBarcode, targetHandlingUnitBarcode: null,
    operationStartedAtFrom: null, operationStartedAtTo: null,
    operationCompletedAtFrom: null, operationCompletedAtTo: null,
    executorId: null, pageNumber: 1, pageSize: 500,
  })
  const sorted = [...items].sort((a, b) => new Date(b.operationCompletedAt || 0) - new Date(a.operationCompletedAt || 0))
  const byUser = new Map()
  let picked = 0
  for (const it of sorted) {
    const q = it.sourceQuantity
    picked += Math.max(0, (Number(q?.oldQuantity) || 0) - (Number(q?.newQuantity) || 0))
    const u = it.responsibleUser
    const key = u?.id || [u?.lastName, u?.firstName].join(' ')
    if (!u || !key.trim()) continue
    const cur = byUser.get(key) || { user: u, count: 0, lastAt: it.operationCompletedAt }
    cur.count++
    byUser.set(key, cur)
  }
  return {
    total: total ?? items.length,
    complete: items.length >= (total ?? items.length),
    picked,
    lastAt: sorted[0]?.operationCompletedAt || null,
    lastType: sorted[0]?.operationType || null,
    pickers: [...byUser.values()],
  }
}
