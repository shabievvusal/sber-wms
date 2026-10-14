import { useEffect } from 'react'
import { pingPresence } from '@/lib/api'

// «Был в сети»: пока пользователь на сайте и вкладка видна, раз в минуту
// сообщаем серверу «я здесь» (POST /api/vs/auth/ping). Скрытая/свёрнутая
// вкладка сигналов не шлёт — человек «не в сети», даже если сайт открыт.
// Вернулся на вкладку — сигнал сразу, не дожидаясь следующей минуты.
export const PRESENCE_INTERVAL_MS = 60_000
// «В сети» на экране — если последний сигнал не старше этого (интервал + запас)
export const ONLINE_WINDOW_MS = 150_000

export function usePresence(enabled) {
  useEffect(() => {
    if (!enabled) return
    let last = 0
    const ping = () => {
      if (document.visibilityState !== 'visible') return
      // не чаще раза в 20 с, даже если вкладку дёргают туда-сюда
      if (Date.now() - last < 20_000) return
      last = Date.now()
      pingPresence()
    }
    ping()
    const timer = setInterval(ping, PRESENCE_INTERVAL_MS)
    document.addEventListener('visibilitychange', ping)
    window.addEventListener('focus', ping)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', ping)
      window.removeEventListener('focus', ping)
    }
  }, [enabled])
}
