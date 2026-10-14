import { useState } from 'react'
import { toast } from 'sonner'
import {
  Check, ChevronDown, Copy, Download, FolderOpen, MousePointerClick, PackageOpen,
  Puzzle, RefreshCw, ShieldCheck, ToggleRight, Warehouse,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { EXT_VERSION } from '@/lib/embed'

// Страница «Расширение для WMS»: скачать архив расширения (собирается из
// папки extension/ при сборке сайта — frontend-app/extension-bundle.js),
// пошаговая установка и ответы на частые вопросы.

const ZIP_URL = '/extension/zlp-wms-extension.zip'
const FOLDER = 'zlp-wms-extension'

const BROWSERS = {
  chrome: { label: 'Chrome', url: 'chrome://extensions', dev: 'Режим разработчика', load: 'Загрузить распакованное расширение', where: 'справа вверху' },
  edge: { label: 'Edge', url: 'edge://extensions', dev: 'Режим разработчика', load: 'Загрузить распакованное', where: 'слева внизу' },
  yandex: { label: 'Яндекс Браузер', url: 'browser://extensions', dev: 'Режим разработчика', load: 'Загрузить распакованное расширение', where: 'справа вверху' },
}

function CopyChip({ text }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setDone(true)
      setTimeout(() => setDone(false), 1500)
    } catch {
      toast.info(`Скопируйте вручную: ${text}`)
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-1.5 font-mono text-sm transition-colors hover:border-brand hover:text-brand"
      title="Скопировать адрес — вставьте его в адресную строку браузера"
    >
      {text}
      {done ? <Check className="size-3.5 text-good" /> : <Copy className="size-3.5 text-muted-foreground" />}
    </button>
  )
}

/** Шаг установки: номер, иконка, текст и «как это выглядит». */
function Step({ n, icon: Icon, title, children, visual }) {
  return (
    <li className="grid gap-4 rounded-3xl border border-line bg-card p-5 shadow-card md:grid-cols-[1fr_280px] md:items-center">
      <div className="flex gap-4">
        <span className="bg-brand-gradient grid size-9 shrink-0 place-items-center rounded-2xl text-sm font-semibold text-white shadow-card">{n}</span>
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <Icon className="size-4 text-brand" /> {title}
          </div>
          <div className="space-y-2 text-sm leading-relaxed text-ink-2">{children}</div>
        </div>
      </div>
      {visual && <div className="rounded-2xl border border-line bg-surface-2/60 p-4">{visual}</div>}
    </li>
  )
}

/* ── «Как это выглядит» — упрощённые макеты элементов браузера/WMS ── */
const DevToggleVisual = ({ b }) => (
  <div className="flex items-center justify-between gap-3 rounded-xl bg-surface px-3 py-2.5 shadow-card">
    <span className="text-sm font-medium">{b.dev}</span>
    <span className="relative h-5 w-9 rounded-full bg-brand"><span className="absolute top-0.5 right-0.5 size-4 rounded-full bg-white" /></span>
  </div>
)
const LoadButtonVisual = ({ b }) => (
  <div className="space-y-2">
    <div className="inline-flex rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium shadow-card">{b.load}</div>
    <div className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-xs text-muted-foreground shadow-card">
      <FolderOpen className="size-4 shrink-0 text-warning" /> <span className="min-w-0 truncate">…\{FOLDER}</span>
      <span className="ml-auto shrink-0 whitespace-nowrap rounded-md bg-brand px-2 py-0.5 text-[11px] font-medium text-white">Выбор папки</span>
    </div>
  </div>
)
const InstalledVisual = () => (
  <div className="flex items-center gap-3 rounded-xl bg-surface p-3 shadow-card">
    <span className="grid size-9 place-items-center rounded-xl bg-brand-soft text-brand"><Puzzle className="size-4" /></span>
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-medium">СберЛогистика в WMS</div>
      <div className="text-xs text-muted-foreground">Версия {EXT_VERSION}</div>
    </div>
    <span className="relative h-5 w-9 rounded-full bg-brand"><span className="absolute top-0.5 right-0.5 size-4 rounded-full bg-white" /></span>
  </div>
)
const WmsMenuVisual = () => (
  <div className="space-y-1 rounded-xl bg-surface p-2 text-sm shadow-card">
    <div className="px-2 py-1 text-muted-foreground">Отчёты</div>
    <div className="flex items-center gap-2 rounded-lg bg-brand-soft px-2 py-1 font-medium text-brand">
      <Warehouse className="size-4" /> СберЛогистика <ChevronDown className="ml-auto size-3.5" />
    </div>
    <div className="pl-8 text-xs text-muted-foreground">Статистика · Мониторинг · Выдача ТСД…</div>
  </div>
)

const FAQ = [
  {
    q: 'Почему нельзя установить в один клик, как из магазина?',
    a: 'Chrome и Edge разрешают установку в один клик только из своих магазинов расширений. Расширение из архива ставится через «Режим разработчика» — это обычный способ для внутренних расширений компании. Установка занимает пару минут и делается один раз.',
  },
  {
    q: 'Браузер при запуске пишет «Отключите расширения в режиме разработчика». Что делать?',
    a: 'Нажмите «Закрыть» (или крестик). Это предупреждение браузер показывает для всех расширений, установленных из папки, а не из магазина. Расширение не отключится.',
  },
  {
    q: 'Переключатель «Режим разработчика» серый или есть надпись «Управляется вашей организацией».',
    a: 'Значит, установка расширений на этом компьютере запрещена политикой. Попросите ИТ разрешить расширение или установить его через групповые политики.',
  },
  {
    q: 'В меню WMS не появился пункт «СберЛогистика».',
    a: 'Обновите страницу WMS (F5). Проверьте на странице расширений, что «СберЛогистика в WMS» включено и без ошибок. Если меню WMS сильно изменилось, вместо пункта появится круглая кнопка «СберЛогистика» слева внизу — разделы открываются из неё.',
  },
  {
    q: 'Внутри WMS сайт снова просит войти — я же уже вошёл на robops.ru.',
    a: 'Внутри WMS вход отдельный — так требует браузер для встроенных окон. Войдите один раз тем же телефоном и паролем, дальше вход помнится 30 дней. Выйти — кнопка «Выйти» в верхней полосе раздела.',
  },
  {
    q: 'Раздел открывается пустым или пишет «Не удаётся подключиться».',
    a: 'Проверьте, что robops.ru открывается в этом браузере отдельной вкладкой. Если открывается, а внутри WMS — нет, сообщите администратору сайта.',
  },
  {
    q: 'В Поставках внутри WMS пишет «Нет активного WMS-токена».',
    a: 'Расширение берёт токен из открытой сессии WMS. Обновите страницу WMS или перезайдите в WMS — через несколько секунд токен подхватится.',
  },
  {
    q: 'Можно ли удалить или переместить распакованную папку?',
    a: `Нет — браузер читает расширение прямо из неё. Если папку удалить, расширение перестанет работать. Храните её в постоянном месте, например C:\\${FOLDER}.`,
  },
  {
    q: 'Что расширение делает с моими данными?',
    a: 'Только встраивает разделы robops.ru в меню WMS и передаёт сайту токен текущей сессии WMS — чтобы разделы, которые работают с WMS, не требовали отдельного входа. Никуда, кроме robops.ru, данные не отправляются. Пароль WMS расширение не видит.',
  },
  {
    q: 'Как удалить расширение?',
    a: 'Откройте страницу расширений браузера, у «СберЛогистика в WMS» нажмите «Удалить». После этого папку можно удалить.',
  },
]

export default function ExtensionPage() {
  const [browser, setBrowser] = useState('chrome')
  const b = BROWSERS[browser]

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      {/* Шапка */}
      <div className="relative overflow-hidden rounded-3xl border border-line bg-card p-6 shadow-card md:p-8">
        <div className="pointer-events-none absolute -top-24 -right-16 size-72 rounded-full bg-brand/10 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-6">
          <span className="bg-brand-gradient grid size-16 shrink-0 place-items-center rounded-3xl text-white shadow-float">
            <Puzzle className="size-8" />
          </span>
          <div className="min-w-0 flex-1 basis-72 space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">Расширение для WMS</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Разделы СберЛогистики прямо в меню WMS (wwh.samokat.ru) — статистика, мониторинг, выдача ТСД и остальные открываются внутри WMS, без переключения между сайтами.
            </p>
            <p className="text-xs text-muted-foreground">Версия {EXT_VERSION} · Chrome, Edge, Яндекс Браузер</p>
          </div>
          <Button asChild size="lg">
            <a href={ZIP_URL} download>
              <Download className="size-4" /> Скачать расширение
            </a>
          </Button>
        </div>
      </div>

      {/* Выбор браузера */}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Установка</h2>
        <div className="inline-flex rounded-xl border border-line bg-surface-2 p-0.5">
          {Object.entries(BROWSERS).map(([key, v]) => (
            <button
              key={key}
              type="button"
              onClick={() => setBrowser(key)}
              className={cn('rounded-[10px] px-3 py-1.5 text-sm font-medium transition-colors', browser === key ? 'bg-surface text-foreground shadow-card' : 'text-muted-foreground hover:text-ink-2')}
            >
              {v.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">займёт 2–3 минуты, делается один раз</span>
      </div>

      <ol className="space-y-3">
        <Step n={1} icon={Download} title="Скачайте архив"
          visual={<Button asChild variant="outline" className="w-full"><a href={ZIP_URL} download><Download className="size-4" /> zlp-wms-extension.zip</a></Button>}>
          <p>Нажмите «Скачать расширение» — загрузится архив <b className="font-medium text-foreground">zlp-wms-extension.zip</b>.</p>
        </Step>
        <Step n={2} icon={PackageOpen} title="Распакуйте в постоянную папку"
          visual={<div className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2.5 text-sm shadow-card"><FolderOpen className="size-4 text-warning" /> <span className="font-mono text-xs">C:\{FOLDER}</span></div>}>
          <p>Правый клик по архиву → «Извлечь всё…». Положите папку <b className="font-medium text-foreground">{FOLDER}</b> туда, где она будет лежать постоянно, например <span className="font-mono">C:\{FOLDER}</span>.</p>
          <p className="text-warning">Не удаляйте и не перемещайте папку после установки — браузер читает расширение прямо из неё.</p>
        </Step>
        <Step n={3} icon={Puzzle} title="Откройте страницу расширений" visual={<div className="flex justify-center"><CopyChip text={b.url} /></div>}>
          <p>Скопируйте адрес и вставьте в адресную строку {b.label}, нажмите Enter. (Сайт не может открыть эту страницу сам — так устроены браузеры.)</p>
        </Step>
        <Step n={4} icon={ToggleRight} title={`Включите «${b.dev}»`} visual={<DevToggleVisual b={b} />}>
          <p>Переключатель {b.where} на странице расширений.</p>
        </Step>
        <Step n={5} icon={MousePointerClick} title={`Нажмите «${b.load}»`} visual={<LoadButtonVisual b={b} />}>
          <p>Выберите распакованную папку <b className="font-medium text-foreground">{FOLDER}</b> — ту, внутри которой лежит файл <span className="font-mono">manifest.json</span>.</p>
          <p>В списке появится «СберЛогистика в WMS».</p>
        </Step>
        <Step n={6} icon={Warehouse} title="Обновите WMS" visual={<WmsMenuVisual />}>
          <p>Откройте или обновите <b className="font-medium text-foreground">wwh.samokat.ru</b> — в меню после «Отчёты» появится пункт «СберЛогистика» с разделами сайта.</p>
          <p>В первый раз внутри WMS войдите на сайт тем же телефоном и паролем — дальше вход помнится 30 дней.</p>
        </Step>
      </ol>

      {/* Обновление */}
      <div className="flex flex-wrap items-start gap-4 rounded-3xl border border-line bg-card p-5 shadow-card">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand"><RefreshCw className="size-5" /></span>
        <div className="min-w-0 flex-1 basis-72 space-y-1.5 text-sm leading-relaxed text-ink-2">
          <div className="text-[15px] font-semibold tracking-tight text-foreground">Как обновить</div>
          <p>Когда выйдет новая версия, в WMS в полосе раздела появится оранжевая плашка «Доступно обновление», а у пункта «СберЛогистика» — точка.</p>
          <p>Скачайте архив заново, распакуйте его <b className="font-medium text-foreground">в ту же папку</b> с заменой файлов, на странице расширений нажмите у «СберЛогистика в WMS» круговую стрелку «Обновить» и обновите WMS.</p>
        </div>
        <InstalledVisual />
      </div>

      {/* FAQ */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Частые вопросы</h2>
        <div className="overflow-hidden rounded-3xl border border-line bg-card shadow-card">
          {FAQ.map((f, i) => (
            <details key={i} className="group border-b border-line last:border-0">
              <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4 text-sm font-medium transition-colors hover:bg-surface-2/50 [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 flex-1">{f.q}</span>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <div className="px-5 pb-4 text-sm leading-relaxed text-ink-2">{f.a}</div>
            </details>
          ))}
        </div>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5" /> Расширение работает только на wwh.samokat.ru и общается только с robops.ru.
        </p>
      </div>
    </div>
  )
}
