import { useEffect, useState } from 'react'
import * as api from '@/lib/api'
import { setHash } from '@/lib/hashRoute'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/context/AuthContext'
import { StepType } from './StepType'
import { StepSearch } from './StepSearch'
import { StepData } from './StepData'
import { StepEoList } from './CfzEoPanel'
import { fmtDate, shortFio } from './format'
import { ArrowLeft } from 'lucide-react'

// Перенесено из оригинала (frontend/app/src/pages/receive/ReceivePage.jsx) —
// кио­ск отгрузки/приёмки РК, отдельный инструмент от SuppliesPage (тот —
// отчётность по поставкам из WMS, этот — операционный ввод данных кладовщиком
// на складе). См. PLAN.md по деталям упрощений.
//
// NameScreen оригинала не перенесён — он нигде не рендерился (мёртвый код).
// ФИО оператора устройства теперь берётся из useAuth().user.name (см. фикс
// «убрать мок-имя Смирнов» — 2026-07-15): раньше здесь было фиксированное
// демо-имя, оставшееся с тех пор, когда в проекте ещё не было реальной
// авторизации — с тех пор `AuthContext`/`useAuth()` появился и используется
// по всему приложению, комментарий об «отсутствии глобального контекста»
// устарел.
//
// Шаг мастера живёт не в локальном состоянии, а в адресной строке
// (`#/receive/<opType>/<routeId>`, см. lib/hashRoute.js): у каждого маршрута
// свой адрес, поэтому перезагрузка страницы (или ссылка/закладка) возвращает
// кладовщика ровно в его маршрут, а не в начало мастера. Раньше любое
// обновление страницы отбрасывало на выбор операции.
const OP_TYPES = ['ship', 'receive', 'eo_list']

export default function ReceivePage({ initialId, initialSub }) {
  const { user } = useAuth()
  const currentUserName = user?.name ? shortFio(user.name) : ''

  const opType = OP_TYPES.includes(initialId) ? initialId : null
  const routeId = opType ? initialSub : null
  const step = !opType ? 'type' : !routeId ? 'search' : 'data'

  // Маршрут из адресной строки: при выборе из списка он уже на руках
  // (`selectRoute`), после перезагрузки — догружаем по routeId.
  const [route, setRoute] = useState(null)
  const [routeError, setRouteError] = useState('')

  useEffect(() => {
    if (!routeId) { setRoute(null); setRouteError(''); return }
    let cancelled = false
    setRouteError('')
    setRoute(prev => (prev?.routeId === routeId ? prev : null))
    api.getRkRoute(routeId)
      .then(r => { if (!cancelled) setRoute(r) })
      .catch(err => { if (!cancelled) setRouteError(err.message || 'Маршрут не найден') })
    return () => { cancelled = true }
  }, [routeId])

  const goBack = () => {
    if (step === 'data') setHash('receive', opType)
    else setHash('receive')
  }
  const selectType = type => setHash('receive', type)
  const selectRoute = r => { setRoute(r); setHash('receive', opType, r.routeId) }
  const resetToType = () => setHash('receive')

  const headerTitle = step === 'type'
    ? 'РК — Склад'
    : step === 'search'
      ? (opType === 'ship' ? 'Отгрузка' : opType === 'eo_list' ? 'Список ЕО' : 'Приёмка')
      : route?.routeNumber || fmtDate(route?.date) || '—'

  return (
    <div className="mx-auto w-full max-w-xl space-y-4 p-6">
      <div className="flex items-center gap-3">
        {step !== 'type' && (
          <Button size="icon" variant="ghost" onClick={goBack}><ArrowLeft className="size-4" /></Button>
        )}
        <h1 className="text-lg font-semibold">{headerTitle}</h1>
        <span className="ml-auto text-sm text-muted-foreground">{currentUserName}</span>
      </div>

      {step === 'type' && <StepType onSelect={selectType} />}
      {step === 'search' && <StepSearch opType={opType} onSelect={selectRoute} />}
      {step === 'data' && routeError && <div className="text-sm text-destructive">{routeError}</div>}
      {step === 'data' && !route && !routeError && <Spinner label="Загрузка маршрута..." />}
      {step === 'data' && route && opType !== 'eo_list' && (
        <StepData opType={opType} route={route} onDone={resetToType} byName={currentUserName} />
      )}
      {step === 'data' && route && opType === 'eo_list' && <StepEoList key={route.routeId} route={route} />}
    </div>
  )
}
