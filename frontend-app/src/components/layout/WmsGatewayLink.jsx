import { Network } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getOwnToken, useWmsGateway } from '@/lib/wmsFetch'

// Строка в меню для тех, кому разработчик разрешил шлюз WMS и у кого нет своей
// сессии WMS: работает ли сайт с WMS через шлюз склада. Остальным не
// показывается. Заявки из меню («Доступ к WMS через шлюз») убраны 07.11.2026 —
// доступ выдаёт только разработчик (Настройки → Шлюз WMS).
export function WmsGatewayLink({ collapsed }) {
  const gw = useWmsGateway()
  if (!gw.loaded || gw.isDeveloper || gw.access !== 'approved' || getOwnToken()) return null
  const text = gw.online ? 'WMS через шлюз' : 'Шлюз WMS не в сети'
  const title = gw.online
    ? 'Своей сессии WMS нет — данные WMS идут через шлюз склада (только просмотр)'
    : 'Шлюз склада сейчас не отвечает — разделы с данными WMS не загрузятся, пока кто-нибудь со своей сессией WMS не откроет сайт'
  return (
    <div
      title={title}
      className={cn('flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-medium text-muted-foreground', collapsed && 'justify-center px-0')}
    >
      <span className="relative shrink-0">
        <Network className="size-4" />
        <span className={cn('absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-surface', gw.online ? 'bg-success' : 'bg-muted-foreground/50')} />
      </span>
      {!collapsed && <span className="truncate">{text}</span>}
    </div>
  )
}
