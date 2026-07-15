// Без этого спиннер/полоса загрузки просто мелькают на один кадр и глаз
// воспринимает это как рывок, а не как анимацию — особенно с демо-данными,
// где ответ приходит почти мгновенно (это и была причина «дёргается»/
// «не видно, как крутится»). withMinDuration гарантирует, что состояние
// загрузки провисит на экране хотя бы minMs, даже если сам запрос был быстрее.
export async function withMinDuration(fn, minMs = 450) {
  const startedAt = Date.now()
  try {
    return await fn()
  } finally {
    const remaining = minMs - (Date.now() - startedAt)
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
  }
}
