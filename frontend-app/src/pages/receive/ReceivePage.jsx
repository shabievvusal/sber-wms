import { useState } from 'react'
import { Button } from '@/components/ui/button'
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
export default function ReceivePage() {
  const { user } = useAuth()
  const currentUserName = user?.name ? shortFio(user.name) : ''
  const [step, setStep] = useState('type') // 'type' | 'search' | 'data'
  const [opType, setOpType] = useState(null) // 'ship' | 'receive' | 'eo_list'
  const [selectedRoute, setSelectedRoute] = useState(null)

  const goBack = () => {
    if (step === 'data') { setStep('search'); setSelectedRoute(null) }
    else { setStep('type'); setOpType(null) }
  }
  const selectType = type => { setOpType(type); setStep('search') }
  const selectRoute = route => { setSelectedRoute(route); setStep('data') }
  const resetToType = () => { setStep('type'); setOpType(null); setSelectedRoute(null) }

  const headerTitle = step === 'type'
    ? 'РК — Склад'
    : step === 'search'
      ? (opType === 'ship' ? 'Отгрузка' : opType === 'eo_list' ? 'Список ЕО' : 'Приёмка')
      : selectedRoute?.routeNumber || fmtDate(selectedRoute?.date) || '—'

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
      {step === 'data' && selectedRoute && opType !== 'eo_list' && (
        <StepData opType={opType} route={selectedRoute} onDone={resetToType} byName={currentUserName} />
      )}
      {step === 'data' && selectedRoute && opType === 'eo_list' && <StepEoList route={selectedRoute} />}
    </div>
  )
}
