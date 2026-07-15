/**
 * Тонкая анимированная полоса поверх контейнера (top-0, position: absolute) —
 * стандартный индикатор фоновой перезагрузки данных (как в GitHub/YouTube),
 * вместо подмены содержимого на скелет или затемнения всей таблицы. Родитель
 * должен быть `relative` и `overflow-hidden`.
 */
export function TopLoadingBar({ active }) {
  if (!active) return null
  return (
    <div className="absolute inset-x-0 top-0 z-30 h-0.5 overflow-hidden bg-primary/15">
      <div
        className="h-full w-1/4 rounded-full bg-primary"
        style={{ animation: 'loading-bar-slide 1s ease-in-out infinite' }}
      />
    </div>
  )
}
