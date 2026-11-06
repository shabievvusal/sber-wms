// Прогресс выгрузки файлов (Excel и др.): карточка внизу справа — какой файл,
// что сейчас делается («Загружаю данные», «Лист «Сотрудники»», «Сохраняю
// файл») и полоса. Где известно «сколько всего» (дни, страницы, листы, строки)
// — полоса с процентами, иначе бегущая. Одна выгрузка за раз.
//
//   await runExport('простои_2026-11-06.xlsx', async p => {
//     const rows = await loadRows()          // можно p.stage('Загружаю данные')
//     const ExcelJS = await p.excel()
//     ...                                    // в длинных циклах — await p.step(i, n)
//     await p.save(wb, 'простои_2026-11-06.xlsx')
//   })
//
// Функции, которые сами собирают файл и могут вызываться изнутри другой
// выгрузки, принимают `p` необязательным параметром — withExport(p, …).
import { useEffect, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { Check, FileDown, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

let current = null // { title, stage, done, total, status: 'run'|'ok'|'error', error, startedAt }
const listeners = new Set()
const emit = next => { current = next; listeners.forEach(l => l()) }
const patch = p => { if (current) emit({ ...current, ...p }) }
const subscribe = l => { listeners.add(l); return () => listeners.delete(l) }

// отдать поток браузеру, чтобы он перерисовал полосу: сборка файла синхронная
// и без пауз заняла бы его целиком — полоса стояла бы до самого конца
const frame = () => new Promise(r => setTimeout(r, 0))

let hideTimer = null

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function runExport(title, fn) {
  if (current?.status === 'run') { toast.info('Дождитесь окончания текущей выгрузки'); return undefined }
  clearTimeout(hideTimer)
  emit({ title, stage: 'Подготовка…', done: 0, total: 0, status: 'run', error: null, startedAt: Date.now() })
  let lastYield = performance.now()
  let downloaded = false
  const p = {
    /** Новый шаг: подпись и (если известно) сколько всего единиц в нём. */
    async stage(text, total = 0) {
      patch({ stage: text, done: 0, total })
      lastYield = performance.now()
      await frame()
    },
    /** Сколько сделано в текущем шаге; в длинных циклах — раз в итерацию. */
    async step(done, total, text) {
      patch({ done, ...(total != null ? { total } : {}), ...(text ? { stage: text } : {}) })
      if (performance.now() - lastYield > 50) { lastYield = performance.now(); await frame() }
    },
    async excel() {
      await p.stage('Подготовка Excel…')
      return (await import('exceljs')).default
    },
    /** Записать книгу в файл и скачать. */
    async save(wb, fileName) {
      await p.stage('Сохраняю файл…')
      const buf = await wb.xlsx.writeBuffer()
      p.download(new Blob([buf], { type: XLSX_TYPE }), fileName)
    },
    download(blob, fileName) {
      patch({ title: fileName })
      downloadBlob(blob, fileName)
      downloaded = true
    },
    /** Скачать готовый файл с сервера с прогрессом по размеру (Content-Length). */
    async fetchBlob(url, init) {
      await p.stage('Сервер формирует файл…')
      const r = await fetch(url, { credentials: 'include', ...init })
      if (!r.ok) {
        let msg = `HTTP ${r.status}`
        try { const j = await r.json(); msg = j?.error || msg } catch { /* не JSON */ }
        throw new Error(msg)
      }
      const size = Number(r.headers.get('Content-Length')) || 0
      if (!r.body) return r.blob()
      await p.stage('Скачиваю файл…', size)
      const reader = r.body.getReader()
      const parts = []
      let got = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
        got += value.length
        await p.step(got)
      }
      return new Blob(parts, { type: r.headers.get('Content-Type') || 'application/octet-stream' })
    },
  }
  try {
    const result = await fn(p)
    // файла может не быть (нет данных — об этом сказал вызывающий код)
    if (downloaded) {
      emit({ ...current, status: 'ok', stage: 'Готово', done: 0, total: 0 })
      hideTimer = setTimeout(() => emit(null), 2500)
    } else emit(null)
    return result
  } catch (err) {
    // сообщение об ошибке показывает вызывающий код (тостом) — карточку убираем
    emit(null)
    throw err
  }
}

/** Внутри уже идущей выгрузки — её `p`, иначе своя выгрузка с этим названием. */
export const withExport = (p, title, fn) => (p ? fn(p) : runExport(title, fn))

/** Идёт ли сейчас выгрузка — чтобы блокировать кнопку. */
export function useExportBusy() {
  return useSyncExternalStore(subscribe, () => current?.status === 'run')
}

const fmtSize = n => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`)

export function ExportProgress() {
  const s = useSyncExternalStore(subscribe, () => current)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (s?.status !== 'run') return undefined
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [s?.status])
  if (!s) return null

  const determinate = s.status === 'run' && s.total > 0
  const pct = determinate ? Math.min(100, Math.round((s.done / s.total) * 100)) : 0
  const elapsed = Math.max(0, Math.round((now - s.startedAt) / 1000))
  const bytes = s.stage.startsWith('Скачиваю')
  const counter = determinate
    ? (bytes ? `${fmtSize(s.done)} из ${fmtSize(s.total)}` : `${s.done.toLocaleString('ru-RU')} из ${s.total.toLocaleString('ru-RU')}`)
    : ''

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[100] w-[calc(100vw-2rem)] max-w-sm rounded-2xl border bg-popover p-3 text-popover-foreground shadow-lg"
    >
      <div className="flex items-start gap-2.5">
        <div className={cn(
          'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg',
          s.status === 'ok' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-primary/10 text-primary',
        )}>
          {s.status === 'ok' ? <Check className="size-4" /> : <FileDown className="size-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={s.title}>{s.title}</div>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate">{s.status === 'ok' ? 'Файл скачан' : s.stage}</span>
            {s.status === 'run' && (
              <span className="shrink-0 tabular-nums">{determinate ? `${pct}%` : ''}{elapsed >= 3 ? `${determinate ? ' · ' : ''}${elapsed} с` : ''}</span>
            )}
          </div>
        </div>
        {s.status === 'ok' && (
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => emit(null)} aria-label="Закрыть">
            <X className="size-4" />
          </button>
        )}
      </div>
      {s.status === 'run' && (
        <>
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-primary/15">
            {determinate
              ? <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${pct}%` }} />
              : <div className="h-full w-1/4 rounded-full bg-primary" style={{ animation: 'loading-bar-slide 1s ease-in-out infinite' }} />}
          </div>
          {counter && <div className="mt-1 text-right text-[11px] tabular-nums text-muted-foreground">{counter}</div>}
        </>
      )}
    </div>
  )
}
