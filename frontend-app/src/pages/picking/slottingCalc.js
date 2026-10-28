// Расстановка товара по оборачиваемости (штучный отбор). Адрес ячейки:
// ЗОНА-РЯД-СЕКЦИЯ-МЕСТО-ЯРУС (SH-11-2-2-1). Порядок ячеек по маршруту — ряд,
// затем секция, затем место; с какого конца начинается маршрут — настройка
// зоны. «Ближняя зона» — первые goldenPct% ячеек зоны по маршруту.
// Перестановки только внутри зоны (зона = температурный режим): частый
// товар из дальней ячейки ⇄ редкий товар из ближней.

export function parseCell(cell) {
  const p = String(cell || '').split('-')
  if (p.length < 5) return null
  const n = p.slice(1).map(Number)
  if (n.some(x => !Number.isFinite(x))) return null
  return { zone: p[0], row: n[0], section: n[1], place: n[2], tier: n[3] }
}

// rows: [{ cell, code, name, lines, qty, lastAt }] с сервера
// settings: { goldenPct, dirs: { [zone]: { rowsDesc, sectionsDesc } } }
export function analyzeSlotting(rows, { goldenPct = 20, dirs = {} } = {}) {
  // текущий товар ячейки и текущая ячейка товара — по последнему отбору
  const cells = new Map(), products = new Map()
  for (const r of rows) {
    const pos = parseCell(r.cell)
    if (!pos) continue
    const t = new Date(r.lastAt).getTime()
    let c = cells.get(r.cell)
    if (!c) cells.set(r.cell, (c = { cell: r.cell, ...pos, lines: 0, code: null, at: 0 }))
    c.lines += r.lines
    if (t > c.at) { c.at = t; c.code = r.code }
    const key = r.code || r.name
    let p = products.get(key)
    if (!p) products.set(key, (p = { code: key, name: r.name, lines: 0, qty: 0, cell: null, at: 0 }))
    p.lines += r.lines
    p.qty += Number(r.qty) || 0
    if (t > p.at) { p.at = t; p.cell = r.cell; p.name = r.name || p.name }
  }

  const zones = []
  const byZone = new Map()
  for (const c of cells.values()) {
    if (!byZone.has(c.zone)) byZone.set(c.zone, [])
    byZone.get(c.zone).push(c)
  }
  for (const [zone, list] of [...byZone.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const d = dirs[zone] || {}
    list.sort((a, b) => (d.rowsDesc ? b.row - a.row : a.row - b.row) || (d.sectionsDesc ? b.section - a.section : a.section - b.section) || a.place - b.place || a.tier - b.tier)
    list.forEach((c, i) => { c.rank = i })
    const goldenN = Math.max(1, Math.round(list.length * goldenPct / 100))

    // ячейка ↔ товар: только согласованные пары (товар сейчас здесь и здесь сейчас этот товар)
    const slots = list.map(c => {
      const p = c.code != null ? products.get(c.code) : null
      const current = p && p.cell === c.cell ? p : null
      return { ...c, golden: c.rank < goldenN, product: current }
    })
    const placed = slots.filter(s => s.product)
    const totalLines = placed.reduce((s, x) => s + x.product.lines, 0)
    const goldenLines = placed.filter(s => s.golden).reduce((s, x) => s + x.product.lines, 0)

    // ABC по частоте отбора внутри зоны: A — столько самых частых товаров,
    // сколько ячеек в ближней зоне; C — нижняя половина
    const byFreq = [...placed].sort((a, b) => b.product.lines - a.product.lines)
    const aSet = new Set(byFreq.slice(0, goldenN).map(s => s.cell))
    const cStart = Math.floor(byFreq.length / 2)
    const cSet = new Set(byFreq.slice(cStart).map(s => s.cell))
    for (const s of placed) s.cls = aSet.has(s.cell) ? 'A' : cSet.has(s.cell) ? 'C' : 'B'
    const idealLines = byFreq.slice(0, goldenN).reduce((s, x) => s + x.product.lines, 0)

    // частые в дальней зоне (по убыванию) ⇄ редкие в ближней (по возрастанию)
    const farFast = placed.filter(s => s.cls === 'A' && !s.golden).sort((a, b) => b.product.lines - a.product.lines)
    const nearSlow = placed.filter(s => s.golden && s.cls !== 'A').sort((a, b) => a.product.lines - b.product.lines)
    // ближние ячейки без отборов за период (пустые или товар не отбирали) — тоже кандидаты
    const nearIdle = slots.filter(s => s.golden && !s.product)
    const moves = []
    for (let i = 0; i < farFast.length; i++) {
      const from = farFast[i]
      const to = nearSlow[i] || nearIdle[i - nearSlow.length]
      if (!to) break
      const gain = from.product.lines - (to.product?.lines || 0)
      if (gain <= 0) break
      moves.push({ zone, fast: from.product, fastCell: from.cell, fastRank: from.rank, slow: to.product, slowCell: to.cell, slowRank: to.rank, gain })
    }

    // ряды: где отбирают больше всего
    const rowsMap = new Map()
    for (const s of slots) {
      const r = rowsMap.get(s.row) || { row: s.row, cells: 0, lines: 0, golden: 0 }
      r.cells++; r.lines += s.lines; if (s.golden) r.golden++
      rowsMap.set(s.row, r)
    }
    const rowList = [...rowsMap.values()].sort((a, b) => a.row - b.row)

    zones.push({
      zone, cells: list.length, goldenN, products: placed.length, totalLines, goldenLines, idealLines,
      goldenShare: totalLines ? goldenLines / totalLines : null,
      idealShare: totalLines ? idealLines / totalLines : null,
      moves, slots, rows: rowList,
    })
  }
  return zones
}
