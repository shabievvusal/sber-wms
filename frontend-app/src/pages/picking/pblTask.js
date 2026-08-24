// Разбор задачи раскладки КДК (pbl/tasks/by-handling-unit-barcode) — общий для
// «Раскладки КДК» (сколько работы стоит на воротах) и «Зависших задач»
// (сколько работы осталось у того, кто её уже взял).

export const unwrapValue = data => data?.value ?? data

/**
 * Свод задачи по одной ЕО.
 *
 * Штуки и степы — разные числа: в одной ячейке может лежать больше одной
 * штуки (в разобранных 21.08 задачах — 184 шт на 166 степов), поэтому обе
 * величины считаются отдельно.
 *
 * Шаг считается пройденным, когда в ячейку положили всё запланированное.
 * Шаги, где план нулевой (весовой товар — `weightProducts`; во всех
 * виденных задачах он пуст), пройденными не считаются: подтвердить это
 * пока не на чем.
 */
export function summarizePblTask(taskData) {
  const task = unwrapValue(taskData) || {}
  const steps = task.steps || []
  let planned = 0
  let accepted = 0
  let stepsDone = 0
  const qtyByProduct = new Map()

  for (const step of steps) {
    let stepPlanned = 0
    let stepAccepted = 0
    for (const product of step.pieceProducts || []) {
      const plan = Number(product.plannedQuantity) || 0
      const fact = Number(product.acceptedQuantity) || 0
      stepPlanned += plan
      stepAccepted += fact
      if (product.productId) qtyByProduct.set(product.productId, (qtyByProduct.get(product.productId) || 0) + plan)
    }
    planned += stepPlanned
    accepted += stepAccepted
    if (stepPlanned > 0 && stepAccepted >= stepPlanned) stepsDone += 1
  }

  return {
    planned,
    accepted,
    stepsTotal: steps.length,
    stepsDone,
    stepsLeft: steps.length - stepsDone,
    qtyByProduct: [...qtyByProduct],
  }
}
