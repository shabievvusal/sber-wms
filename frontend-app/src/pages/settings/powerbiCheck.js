// Сверка комплектации с PowerBI: одна смена из сырого журнала WMS, посчитанная
// разными способами. Как считает PowerBI, неизвестно — правило находим по
// цифрам: способ, который у нескольких сотрудников совпал с PowerBI, и есть
// его правило. Считается по журналу из WMS, а не по нашей базе: при записи в
// базу часть строк склеивается, и некоторые способы по ней не посчитать.

export const PICK_TYPES = ['PIECE_SELECTION_PICKING', 'PICK_BY_LINE']

const HOUR = 3_600_000

// Границы смены по Москве со сдвигом shiftHours (−1 — на час раньше, 0 — как у нас 09–21/21–09).
export function shiftWindow(date, shift, shiftHours = 0) {
  const start = new Date(`${date}T${shift === 'night' ? '21' : '09'}:00:00+03:00`).getTime() + shiftHours * HOUR
  return { from: start, to: start + 12 * HOUR }
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const fio = u => [u?.lastName, u?.firstName, u?.middleName].filter(s => s && s.trim() && s.trim() !== '-').join(' ').trim()

export function normalize(it) {
  const tq = it.targetQuantity || {}
  const sq = it.sourceQuantity || {}
  return {
    id: it.id ?? '',
    type: (it.operationType || '').toUpperCase(),
    execId: it.responsibleUser?.id || '',
    fio: fio(it.responsibleUser) || it.responsibleUser?.id || '—',
    // ячейка — как у нас при записи: куда, иначе откуда
    cell: it.targetAddress?.cellAddress || it.sourceAddress?.cellAddress || '',
    srcCell: it.sourceAddress?.cellAddress || '',
    tgtHu: it.targetAddress?.handlingUnitBarcode || '',
    product: it.product?.nomenclatureCode || it.product?.name || '',
    at: Date.parse(it.operationCompletedAt),
    tgtOld: num(tq.oldQuantity), tgtNew: num(tq.newQuantity),
    srcOld: num(sq.oldQuantity), srcNew: num(sq.newQuantity),
    raw: it,
  }
}

// Поля строки, похожие на номер задания/заказа/документа — у них тоже
// считаем «уникальных». Ищем на верхнем уровне и на уровень глубже.
const ID_LIKE = /task|order|assign|document|doc|wave|shipment|request|picking|selection/i
export function discoverIdFields(rawRows) {
  const found = new Map() // path → сколько строк с непустым значением
  for (const r of rawRows.slice(0, 500)) {
    for (const [k, v] of Object.entries(r || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v)) {
          if ((typeof v2 === 'string' || typeof v2 === 'number') && v2 !== '' && (ID_LIKE.test(k) || ID_LIKE.test(k2))) {
            found.set(`${k}.${k2}`, (found.get(`${k}.${k2}`) || 0) + 1)
          }
        }
      } else if ((typeof v === 'string' || typeof v === 'number') && v !== '' && ID_LIKE.test(k) && k !== 'operationType') {
        found.set(k, (found.get(k) || 0) + 1)
      }
    }
  }
  return [...found.keys()]
}
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)

// Способы подсчёта. key(line) — что считаем уникальным (null — каждая строка).
export function buildVariants(idFields = []) {
  return [
    { key: 'lines', group: 'СЗ', label: 'Строк журнала', hint: 'каждая строка WMS — одно СЗ', unique: null },
    { key: 'ours', group: 'СЗ', label: 'Как у нас сейчас', hint: 'хранение — по ID строки; КДК — сотрудник + ячейка + товар', unique: l => (l.type === 'PICK_BY_LINE' ? `kdk|${l.cell}|${l.product}` : `op|${l.id}`) },
    { key: 'hu', group: 'СЗ', label: 'ЕО-получателей', hint: 'уникальные ЕО, куда собирали', unique: l => l.tgtHu || `nohu|${l.id}` },
    { key: 'huProduct', group: 'СЗ', label: 'ЕО + товар', hint: 'уникальные пары «ЕО-получатель + товар»', unique: l => `${l.tgtHu}|${l.product}` },
    { key: 'cellProduct', group: 'СЗ', label: 'Ячейка + товар', hint: 'уникальные пары «ячейка + товар»', unique: l => `${l.cell}|${l.product}` },
    { key: 'cellMinute', group: 'СЗ', label: 'Ячейка + минута', hint: 'подходы к ячейке: ячейка + минута завершения', unique: l => `${l.cell}|${Math.floor(l.at / 60_000)}` },
    ...idFields.map(path => ({ key: `f:${path}`, group: 'СЗ', label: `Уник. ${path}`, hint: `уникальные значения поля ${path}`, unique: l => String(getPath(l.raw, path) ?? `none|${l.id}`) })),
    { key: 'qtyDelta', group: 'Штук', label: 'Положено (стало − было)', hint: 'в ЕО-получателе: newQuantity − oldQuantity', qty: l => (l.tgtNew != null && l.tgtOld != null ? l.tgtNew - l.tgtOld : 0) },
    { key: 'qtySrc', group: 'Штук', label: 'Взято (было − стало)', hint: 'в источнике: oldQuantity − newQuantity', qty: l => (l.srcOld != null && l.srcNew != null ? l.srcOld - l.srcNew : 0) },
    { key: 'qtyOurs', group: 'Штук', label: 'Стало в ЕО (как у нас)', hint: 'targetQuantity.newQuantity', qty: l => l.tgtNew ?? l.srcOld ?? 0 },
  ]
}

/** Строки в окне смены и нужного типа → итог и по сотрудникам. */
export function computeCheck(lines, { date, shift, shiftHours = 0, type = 'all', variants, companyById = new Map() }) {
  const { from, to } = shiftWindow(date, shift, shiftHours)
  const inWindow = lines.filter(l => l.at >= from && l.at < to
    && (type === 'all' || (type === 'storage' ? l.type === 'PIECE_SELECTION_PICKING' : l.type === 'PICK_BY_LINE')))

  const blank = () => Object.fromEntries(variants.map(v => [v.key, v.unique ? new Set() : 0]))
  const add = (acc, l) => {
    for (const v of variants) {
      if (v.unique) acc[v.key].add(v.unique(l))
      else if (v.qty) acc[v.key] += v.qty(l)
      else acc[v.key] += 1
    }
  }
  const finish = acc => Object.fromEntries(Object.entries(acc).map(([k, x]) => [k, x instanceof Set ? x.size : x]))

  const byExec = new Map()
  for (const l of inWindow) {
    const key = l.execId || l.fio
    if (!byExec.has(key)) byExec.set(key, { execId: l.execId, fio: l.fio, acc: blank() })
    add(byExec.get(key).acc, l)
  }
  const rows = [...byExec.values()]
    .map(e => ({ execId: e.execId, fio: e.fio, company: companyById.get(e.execId) || '—', values: finish(e.acc) }))
    .sort((a, b) => b.values.lines - a.values.lines)
  // итог — сумма по сотрудникам: одна ЕО/ячейка у двух сотрудников считается у каждого
  const total = Object.fromEntries(variants.map(v => [v.key, rows.reduce((s, r) => s + r.values[v.key], 0)]))
  return { from, to, lines: inWindow.length, total, rows }
}
