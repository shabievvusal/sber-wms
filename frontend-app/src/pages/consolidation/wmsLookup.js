// Реальный поиск нарушителя (ConsolidationPage.jsx) — 1-в-1 порт
// lookupViaBrowser из оригинала (pages/consolidation/ConsolidationPage.jsx).
// Прямые браузерные запросы в api.samokat.ru с WMS-токеном — не
// application-логика (потому не в wmsFetch.js), а специфичный для этой
// страницы алгоритм подбора стратегии поиска (ZGH/точное совпадение/
// фоллбэк), поэтому — отдельный файл рядом со страницей.

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
  const outExact = [], outLoose = []
  for (const it of rawItems) {
    const id = it?.cellId ?? it?.id ?? null
    const addr = normalizeCellAddress(it?.cellAddress || it?.fullAddress || it?.address || it?.name || '')
    if (!id) continue
    if (wantedNorm) {
      if (addr === wantedNorm) { if (!outExact.includes(id)) outExact.push(id) }
      else if (addr.includes(wantedNorm) || wantedNorm.includes(addr)) { if (!outLoose.includes(id)) outLoose.push(id) }
    } else if (!outLoose.includes(id)) outLoose.push(id)
  }
  return outExact.length > 0 ? outExact : outLoose
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
      const ids = extractCellIdList(data, query)
      if (ids.length > 0) return ids
      const any = extractCellIdList(data, '')
      if (any.length > 0) return any
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

function matchesCell(item, cellNorm) {
  return String(item?.targetAddress?.cellAddress || '').trim().toLowerCase() === cellNorm ||
    String(item?.sourceAddress?.cellAddress || '').trim().toLowerCase() === cellNorm
}

function matchesTargetCell(item, cellIds, cellNorm) {
  if (!Array.isArray(cellIds) || cellIds.length === 0) return matchesCell(item, cellNorm)
  const id = item?.targetAddress?.cellId
  if (id) return cellIds.includes(id)
  return matchesCell(item, cellNorm)
}

export async function lookupViaBrowser(token, barcode, cell, createdAt, preScannedEuBarcode) {
  function isoMsk(date) {
    const tzOffset = -3 * 60
    return new Date(date.getTime() - tzOffset * 60000).toISOString().replace('Z', '+03:00')
  }
  const mskOffset = 3 * 60
  const now = new Date()
  const refDate = createdAt ? new Date(createdAt) : now
  const mskRef = new Date(refDate.getTime() + (mskOffset + refDate.getTimezoneOffset()) * 60000)
  const shiftStart = new Date(mskRef)
  if (mskRef.getHours() < 9) {
    shiftStart.setDate(shiftStart.getDate() - 1)
  }
  shiftStart.setHours(9, 0, 0, 0)
  const shiftEnd = new Date(shiftStart)
  shiftEnd.setHours(23, 59, 59, 999)
  const shiftStartUTC = new Date(shiftStart.getTime() - (mskOffset + refDate.getTimezoneOffset()) * 60000)
  const shiftEndUTC = new Date(shiftEnd.getTime() - (mskOffset + refDate.getTimezoneOffset()) * 60000)
  const from24hISO = isoMsk(shiftStartUTC)
  const nowISO = isoMsk(shiftEndUTC)

  const result = {
    productName: null, nomenclatureCode: null, productBarcode: null,
    violator: null, violatorId: null, handlingUnitBarcode: null,
    operationType: null, operationCompletedAt: null,
    lookupDone: true, lookupError: null, strategy: null,
  }

  const barcodeNorm = String(barcode).trim()
  const cellNorm = String(cell || '').trim().toLowerCase()
  let cellIds = []

  try { cellIds = await findCellIdsByAddress(token, cell) } catch { /* ignore */ }

  const baseBody = {
    productId: null, parts: [], operationTypes: [],
    sourceCellId: null, targetCellId: null,
    operationStartedAtFrom: from24hISO, operationStartedAtTo: nowISO,
    operationCompletedAtFrom: from24hISO, operationCompletedAtTo: nowISO,
    executorId: null,
  }

  // ─── ZGH strategy: ЕО → кто комплектовал ───────────────────────────────
  if (String(cell || '').trim().toUpperCase().startsWith('ZGH')) {
    try {
      let euBarcode = null
      let productName = null, nomenclatureCode = null, productBarcode = null

      if (preScannedEuBarcode && String(preScannedEuBarcode).trim()) {
        euBarcode = String(preScannedEuBarcode).trim()
      } else {
        const step1Bodies = cellIds.length > 0
          ? cellIds.map(id => ({ ...baseBody, targetCellId: id }))
          : [{ ...baseBody }]

        let pageNum = 1
        outer: while (true) {
          const batches = await Promise.all(step1Bodies.map(b => wmsPost(token, { ...b, pageNumber: pageNum, pageSize: 500 })))
          const items = batches.flatMap(b => b?.value?.items || [])
          if (!items.length) break
          for (const it of items) {
            if (matchesBarcode(it, barcodeNorm) || matchesHandlingUnitBarcode(it, barcodeNorm)) {
              euBarcode = it?.targetAddress?.handlingUnitBarcode || it?.sourceAddress?.handlingUnitBarcode || null
              productName = it.product?.name || null
              nomenclatureCode = it.product?.nomenclatureCode || null
              productBarcode = pickProductBarcode(it, barcodeNorm)
              break outer
            }
          }
          pageNum++
        }
      }

      result.handlingUnitBarcode = euBarcode

      if (!euBarcode) {
        result.strategy = 'zgh_eu_not_found'
        return result
      }

      // Шаг 2: ищем кто комплектовал эту ЕО по targetHandlingUnitBarcode
      // Дата не ограничивается — ЕО могла быть собрана в любой день
      const euNorm = String(euBarcode).trim()
      const step2Body = {
        productId: null, parts: [], operationTypes: [],
        sourceCellId: null, targetCellId: null,
        operationStartedAtFrom: null, operationStartedAtTo: null,
        operationCompletedAtFrom: null, operationCompletedAtTo: null,
        executorId: null,
        targetHandlingUnitBarcode: euNorm,
      }
      let pageNum2 = 1
      const candidates = []
      while (true) {
        const data = await wmsPost(token, { ...step2Body, pageNumber: pageNum2, pageSize: 500 })
        const items = data?.value?.items || []
        if (!items.length) break
        if (!productName && barcodeNorm) {
          const pi = items.find(it => matchesBarcode(it, barcodeNorm))
          if (pi) {
            productName = pi.product?.name || null
            nomenclatureCode = pi.product?.nomenclatureCode || null
            productBarcode = pickProductBarcode(pi, barcodeNorm)
          }
        }
        candidates.push(...items)
        pageNum2++
      }
      if (!productName && candidates.length > 0) {
        productName = candidates[0].product?.name || null
        nomenclatureCode = candidates[0].product?.nomenclatureCode || null
      }
      result.productName = productName
      result.nomenclatureCode = nomenclatureCode
      result.productBarcode = productBarcode

      const pickingCandidates = candidates.filter(it => LOOKUP_OP_TYPES.includes(it.operationType))
      const finalCandidates = pickingCandidates.length > 0 ? pickingCandidates : candidates
      if (finalCandidates.length > 0) {
        finalCandidates.sort((a, b) => new Date(b.operationCompletedAt || 0) - new Date(a.operationCompletedAt || 0))
        const v = finalCandidates[0]
        result.violator = fioFromUser(v.responsibleUser) || fioFromUser(v.executor) || null
        result.violatorId = v.responsibleUser?.id || v.executorId || null
        result.operationType = v.operationType || null
        result.operationCompletedAt = v.operationCompletedAt || null
        result.strategy = 'zgh_eu_match'
      } else {
        result.strategy = candidates.length > 0 ? 'zgh_no_picking_ops' : 'zgh_violator_not_found'
      }
    } catch (err) {
      result.lookupDone = false
      result.lookupError = err.message || 'Ошибка WMS (ZGH)'
    }
    return result
  }

  // ─── Priority: exact match (cell + barcode) ───────────────────────────────
  try {
    const exactBodies = cellIds.length > 0
      ? cellIds.map(id => ({ ...baseBody, targetCellId: id, operationTypes: LOOKUP_OP_TYPES }))
      : [{ ...baseBody, operationTypes: LOOKUP_OP_TYPES }]

    const pageSize = 500
    let pageNumber = 1
    let exactFound = [], exactMatchMode = null

    while (true) {
      const batches = await Promise.all(exactBodies.map(b => wmsPost(token, { ...b, pageNumber, pageSize })))
      const allItems = batches.flatMap(b => b?.value?.items || [])
      if (allItems.length === 0) break

      const byBarcode = allItems.filter(it => matchesTargetCell(it, cellIds, cellNorm) && matchesBarcode(it, barcodeNorm))
      if (byBarcode.length > 0) { exactFound = byBarcode; exactMatchMode = 'product_barcode'; break }

      const byHU = allItems.filter(it => matchesTargetCell(it, cellIds, cellNorm) && matchesHandlingUnitBarcode(it, barcodeNorm))
      if (byHU.length > 0) { exactFound = byHU; exactMatchMode = 'handling_unit_barcode'; break }

      pageNumber++
    }

    if (exactFound.length > 0) {
      exactFound.sort((a, b) => new Date(b.operationCompletedAt || 0) - new Date(a.operationCompletedAt || 0))
      const ex = exactFound[0]
      result.productName = ex.product?.name || null
      result.nomenclatureCode = ex.product?.nomenclatureCode || null
      result.productBarcode = pickProductBarcode(ex, barcodeNorm)
      result.violator = fioFromUser(ex.responsibleUser) || fioFromUser(ex.executor) || null
      result.violatorId = ex.responsibleUser?.id || ex.executorId || null
      result.handlingUnitBarcode = ex?.targetAddress?.handlingUnitBarcode || ex?.sourceAddress?.handlingUnitBarcode || null
      result.operationType = ex.operationType || null
      result.operationCompletedAt = ex.operationCompletedAt || null
      result.strategy = exactMatchMode === 'handling_unit_barcode' ? 'exact_cell_and_handling_unit_barcode' : 'exact_cell_and_barcode'
      return result
    }
  } catch { /* fallback */ }

  // ─── Fallback: search by cell, filter by barcode on client ────────────────
  const fallbackBodies = cellIds.length > 0
    ? cellIds.map(id => ({ ...baseBody, targetCellId: id, operationTypes: LOOKUP_OP_TYPES }))
    : [{ ...baseBody, operationTypes: LOOKUP_OP_TYPES }]

  let itemsA = [], foundByHandlingUnit = false
  const pageSize = 500
  let pageNumber = 1

  while (true) {
    const batches = await Promise.all(fallbackBodies.map(b => wmsPost(token, { ...b, pageNumber, pageSize })))
    const allItems = batches.flatMap(b => b?.value?.items || [])
    if (allItems.length === 0) break

    const byBarcode = allItems.filter(it => matchesBarcode(it, barcodeNorm))
    if (byBarcode.length > 0) { itemsA = byBarcode; foundByHandlingUnit = false; break }

    const byHU = allItems.filter(it => matchesHandlingUnitBarcode(it, barcodeNorm))
    if (byHU.length > 0) { itemsA = byHU; foundByHandlingUnit = true; break }

    pageNumber++
  }

  result.strategy = itemsA.length > 0
    ? (foundByHandlingUnit ? 'handling_unit_match_paginated' : 'ean_match_paginated')
    : 'not_found'

  if (itemsA.length === 0) return result

  itemsA.sort((a, b) => new Date(b.operationCompletedAt || 0) - new Date(a.operationCompletedAt || 0))
  const first = itemsA[0]
  result.productName = first.product?.name || null
  result.nomenclatureCode = first.product?.nomenclatureCode || null

  const productId = first.product?.productId ?? first.productId ?? null
  if (!productId || !cell) return result

  // ─── Step B: find violator ────────────────────────────────────────────────
  const stepBQueries = cellIds.length > 0
    ? cellIds.map(id => wmsPost(token, { ...baseBody, productId, targetCellId: id, pageNumber: 1, pageSize: 500 }))
    : [wmsPost(token, { ...baseBody, productId, pageNumber: 1, pageSize: 500 })]

  const stepBData = await Promise.all(stepBQueries)
  const itemsB = stepBData.flatMap(x => x?.value?.items || [])

  const matched = itemsB.filter(it => matchesTargetCell(it, cellIds, cellNorm) && matchesBarcode(it, barcodeNorm))
  const matchedFinal = matched.length > 0
    ? matched
    : itemsB.filter(it => matchesTargetCell(it, cellIds, cellNorm) && matchesHandlingUnitBarcode(it, barcodeNorm))

  if (matchedFinal.length > 0) {
    matchedFinal.sort((a, b) => new Date(b.operationCompletedAt || 0) - new Date(a.operationCompletedAt || 0))
    const v = matchedFinal[0]
    result.violator = fioFromUser(v.responsibleUser) || fioFromUser(v.executor) || null
    result.violatorId = v.responsibleUser?.id || v.executorId || null
    result.productBarcode = pickProductBarcode(v, barcodeNorm)
    result.handlingUnitBarcode = v?.targetAddress?.handlingUnitBarcode || v?.sourceAddress?.handlingUnitBarcode || null
    result.operationType = v.operationType || null
    result.operationCompletedAt = v.operationCompletedAt || null
  }

  return result
}
