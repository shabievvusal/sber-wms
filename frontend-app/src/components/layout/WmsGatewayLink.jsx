import { useState } from 'react'
import { toast } from 'sonner'
import { Network } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getOwnToken, useWmsGateway, requestGatewayAccess } from '@/lib/wmsFetch'

// Строка в меню для тех, у кого нет своей сессии WMS: работает ли сайт с WMS
// через шлюз склада, ждёт ли заявка одобрения разработчика, или можно её
// оставить. Со своей сессией WMS (и у разработчика) — не показывается.
export function WmsGatewayLink({ collapsed }) {
  const gw = useWmsGateway()
  const [busy, setBusy] = useState(false)
  if (!gw.loaded || gw.isDeveloper || getOwnToken()) return null

  const request = async () => {
    setBusy(true)
    try {
      await requestGatewayAccess()
      toast.success('Заявка отправлена — доступ к WMS через шлюз выдаёт разработчик')
    } catch (err) {
      toast.error(err.message || 'Не удалось отправить заявку')
    } finally {
      setBusy(false)
    }
  }

  let text, title, dot, onClick = null
  if (gw.access === 'approved') {
    text = gw.online ? 'WMS через шлюз' : 'Шлюз WMS не в сети'
    title = gw.online
      ? 'Своей сессии WMS нет — данные WMS идут через шлюз склада (только просмотр)'
      : 'Шлюз склада сейчас не отвечает — разделы с данными WMS не загрузятся, пока он не появится в сети'
    dot = gw.online ? 'bg-success' : 'bg-muted-foreground/50'
  } else if (gw.access === 'pending') {
    text = 'Заявка на шлюз WMS'
    title = 'Заявка на доступ к WMS через шлюз ждёт одобрения разработчика'
    dot = 'bg-warning'
  } else {
    text = 'Доступ к WMS через шлюз'
    title = (gw.access === 'revoked' ? 'Доступ к шлюзу отозван. ' : '')
      + 'Нет своей сессии WMS — можно попросить доступ к данным WMS через шлюз склада (только просмотр). Одобряет разработчик.'
    dot = 'bg-muted-foreground/40'
    onClick = request
  }

  return (
    <button
      type="button"
      title={title}
      disabled={!onClick || busy}
      onClick={onClick || undefined}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-medium text-muted-foreground transition-colors',
        onClick ? 'hover:bg-surface-2 hover:text-foreground' : 'cursor-default',
        collapsed && 'justify-center px-0',
      )}
    >
      <span className="relative shrink-0">
        <Network className="size-4" />
        <span className={cn('absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-surface', dot)} />
      </span>
      {!collapsed && <span className="truncate">{busy ? 'Отправляю…' : text}</span>}
    </button>
  )
}
