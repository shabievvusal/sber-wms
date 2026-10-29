// Поиск нарушителя по жалобе (ConsolidationPage.jsx): прямые запросы из
// браузера в api.samokat.ru с WMS-токеном. Операции комплектации в ячейку
// жалобы (фильтр WMS по targetCellId) за 24 ч до жалобы — нарушитель тот,
// кто последним положил туда отсканированный товар (или ЕО). id ячейки —
// из справочника «Ячейки и ЦФЗ»; нет там — один запрос в WMS по адресу.

const SAMOKAT_STOCKS_URL = 'https://api.samokat.ru/wmsops-wwh/stocks/changes/search'
const SAMOKAT_CELLS_URL = 'https://api.samokat.ru/wmsops-wwh/topology/cells/filters/by-address-search'
const LOOKUP_OP_TYPES = [
  'PIECE_SELECTION_PICKING',
  'PIECE_SELECTION_PICKING_COMPLETE',
  'PICK_BY_LINE',
  'PALLET_SELECTION_MOVE_TO_PICK_BY_LINE',
]

async function wmsPost(token, body) {
  const r = await fetch(SAMOKAT_STOCKS_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Origin': 'https://wwh.samokat.ru',
      'Referer': 'https://wwh.samokat.ru/',
    },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`API ${r.status}`)
  return JSON.parse(text)
}

async function wmsGet(token, url) {
  const r = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Origin': 'https://wwh.samokat.ru',
      'Referer': 'https://wwh.samokat.ru/',
    },
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`API ${r.status}`)
  return JSON.parse(text)
}

function normalizeCellAddress(str) {
  return String(str || '').trim().toLowerCase().replace(/\s+/g, '').replace(/[—–−]/g, '-')
}

function extractCellIdList(data, wantedAddressNorm) {
  const value = data?.value || data || {}
  const lists = [
    value?.items, data?.items, value?.content, data?.content,
    value?.cells, data?.cells,
    Array.isArray(value) ? value : null,
    Array.isArray(data) ? data : null,
  ].filter(Array.isArray)
  const rawItems = lists.flat()
  const wantedNorm = normalizeCellAddress(wantedAddressNorm)
  const outExact = []
  for (const it of rawItems) {
    const id = it?.cellId ?? it?.id ?? null
    const addr = normalizeCellAddress(it?.cellAddress || it?.fullAddress || it?.address || it?.name || '')
    if (!id) continue
    if (addr === wantedNorm && !outExact.includes(id)) outExact.push(id)
  }
  return outExact
}

async function findCellIdsByAddress(token, cellAddress) {
  const query = String(cellAddress || '').trim()
  if (!query) return []
  const urls = [
    `${SAMOKAT_CELLS_URL}?cellAddressSearch=${encodeURIComponent(query)}`,
    `${SAMOKAT_CELLS_URL}?cellAddressSearch=${encodeURIComponent(query)}&pageNumber=1&pageSize=50`,
  ]
  for (const url of urls) {
    try {
      const data = await wmsGet(token, url)
      const ids = extractCellIdList(data, query).filter(Boolean)
      if (ids.length > 0) return ids
    } catch { /* try next */ }
  }
  return []
}

function fioFromUser(user) {
  if (!user) return null
  if (typeof user === 'string') return user
  return [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ').trim() || null
}

function matchesBarcode(item, barcodeNorm) {
  const barcodes = item?.product?.barcodes || []
  return barcodes.some(b => String(b).trim() === barcodeNorm) ||
    String(item?.product?.nomenclatureCode || '').trim() === barcodeNorm
}

function matchesHandlingUnitBarcode(item, barcodeNorm) {
  return String(item?.sourceAddress?.handlingUnitBarcode || '').trim() === barcodeNorm ||
    String(item?.targetAddress?.handlingUnitBarcode || '').trim() === barcodeNorm
}

function pickProductBarcode(item, requestedBarcode) {
  const list = Array.isArray(item?.product?.barcodes)
    ? item.product.barcodes.map(x => String(x).trim()).filter(Boolean) : []
  const req = String(requestedBarcode || '').trim()
  if (req && list.includes(req)) return req
  return list[0] || null
}

// Окно поиска: 24 часа до подачи жалобы (захватывает и ночную смену после
// полуночи). Операции после жалобы не могли привести к нарушению.
const LOOKUP_WINDOW_MS = 24 * 3600 * 1000

function lookupWindow(createdAt) {
  const to = createdAt ? new Date(createdAt) : new Date()
  const from = new Date(to.getTime() - LOOKUP_WINDOW_MS)
  return { from: from.toISOString(), to: to.toISOString() }
}

// Все страницы операций по запросу (WMS отдаёт до 500 за раз).
async function fetchAllOps(token, body, maxPages = 40) {
  const out = []
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const data = await wmsPost(token, { ...body, pageNumber, pageSize: 500 })
    const items = data?.value?.items || []
    out.push(...items)
    const total = data?.value?.total ?? 0
    if (!items.length || out.length >= total) break
  }
  return out
}

const latestFirst = list => [...list].sort((a, b) => new Date(b.operationCompletedAt || 0) - new Date(a.operationCompletedAt || 0))

function fillFromOp(result, op, barcodeNorm) {
  result.productName = op.product?.name || null
  result.nomenclatureCode = op.product?.nomenclatureCode || null
  result.productBarcode = pickProductBarcode(op, barcodeNorm)
  result.violator = fioFromUser(op.responsibleUser) || fioFromUser(op.executor) || null
  result.violatorId = op.responsibleUser?.id || op.executorId || null
  result.handlingUnitBarcode = op?.targetAddress?.handlingUnitBarcode || op?.sourceAddress?.handlingUnitBarcode || null
  result.operationType = op.operationType || null
  result.operationCompletedAt = op.operationCompletedAt || null
}

/**
 * Поиск нарушителя: кто последним до жалобы положил отсканированный товар
 * (или ЕО) в ячейку жалобы. cellIdHint — id ячейки WMS из справочника
 * «Ячейки и ЦФЗ» (без него — один запрос в WMS по адресу).
 */
export async function lookupViaBrowser(token, barcode, cell, createdAt, preScannedEuBarcode, cellIdHint) {
  const result = {
    productName: null, nomenclatureCode: null, productBarcode: null,
    violator: null, violatorId: null, handlingUnitBarcode: null,
    operationType: null, operationCompletedAt: null,
    lookupDone: true, lookupError: null, strategy: null,
  }
  const barcodeNorm = String(barcode || '').trim()
  const isZgh = String(cell || '').trim().toUpperCase().startsWith('ZGH')
  const win = lookupWindow(createdAt)
  const baseBody = {
    productId: null, parts: [], operationTypes: [],
    sourceCellId: null, targetCellId: null,
    sourceHandlingUnitBarcode: null, targetHandlingUnitBarcode: null,
    operationStartedAtFrom: null, operationStartedAtTo: null,
    operationCompletedAtFrom: win.from, operationCompletedAtTo: win.to,
    executorId: null,
  }

  // ─── ЗГЗ: ЕО → кто её комплектовал ────────────────────────────────────────
  if (isZgh) {
    try {
      let euBarcode = String(preScannedEuBarcode || '').trim() || null
      if (!euBarcode) {
        const cellIds = cellIdHint ? [cellIdHint] : await findCellIdsByAddress(token, cell)
        if (!cellIds.length) return { ...result, lookupDone: false, lookupError: `Ячейка ${cell} не найдена в WMS` }
        const ops = (await Promise.all(cellIds.map(id => fetchAllOps(token, { ...baseBody, targetCellId: id })))).flat()
        const hit = latestFirst(ops).find(it => matchesBarcode(it, barcodeNorm) || matchesHandlingUnitBarcode(it, barcodeNorm))
        euBarcode = hit?.targetAddress?.handlingUnitBarcode || hit?.sourceAddress?.handlingUnitBarcode || null
      }
      result.handlingUnitBarcode = euBarcode
      if (!euBarcode) { result.strategy = 'zgh_eu_not_found'; return result }

      // ЕО могли собрать в любой день — без ограничения по дате
      const candidates = await fetchAllOps(token, {
        ...baseBody, operationCompletedAtFrom: null, operationCompletedAtTo: null, targetHandlingUnitBarcode: euBarcode,
      })
      const picking = candidates.filter(it => LOOKUP_OP_TYPES.includes(it.operationType))
      const pool = latestFirst(picking.length ? picking : candidates)
      const withProduct = barcodeNorm ? pool.find(it => matchesBarcode(it, barcodeNorm)) : null
      const v = withProduct || pool[0]
      if (!v) { result.strategy = 'zgh_violator_not_found'; return result }
      fillFromOp(result, v, barcodeNorm)
      result.handlingUnitBarcode = euBarcode
      result.strategy = picking.length ? 'zgh_eu_match' : 'zgh_no_picking_ops'
    } catch (err) {
      result.lookupDone = false
      result.lookupError = err.message || 'Ошибка WMS (ZGH)'
    }
    return result
  }

  // ─── Ячейка: операции комплектации в неё за 24 ч до жалобы ────────────────
  try {
    const cellIds = cellIdHint ? [cellIdHint] : await findCellIdsByAddress(token, cell)
    if (!cellIds.length) {
      return { ...result, lookupDone: false, lookupError: `Ячейка ${cell} не найдена в WMS — добавьте или обновите её зону в «Настройки → Ячейки и ЦФЗ»` }
    }
    const ops = (await Promise.all(cellIds.map(id => fetchAllOps(token, { ...baseBody, targetCellId: id, operationTypes: LOOKUP_OP_TYPES })))).flat()
    const sorted = latestFirst(ops)
    let hit = sorted.find(it => matchesBarcode(it, barcodeNorm))
    let mode = 'exact_cell_and_barcode'
    if (!hit) { hit = sorted.find(it => matchesHandlingUnitBarcode(it, barcodeNorm)); mode = 'exact_cell_and_handling_unit_barcode' }
    if (!hit) { result.strategy = 'not_found'; return result }
    fillFromOp(result, hit, barcodeNorm)
    result.strategy = mode
  } catch (err) {
    result.lookupDone = false
    result.lookupError = err.message || 'Ошибка WMS'
  }
  return result
}
