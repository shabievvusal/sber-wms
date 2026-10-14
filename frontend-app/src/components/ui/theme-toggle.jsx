import { Monitor, Moon, Sun } from 'lucide-react'
import { motion } from 'motion/react'
import { useTheme } from '@/lib/theme'

const OPTIONS = [
  { value: 'light', Icon: Sun, label: 'Светлая' },
  { value: 'system', Icon: Monitor, label: 'Как в системе' },
  { value: 'dark', Icon: Moon, label: 'Тёмная' },
]

// Переключатель темы с «переезжающей» подложкой — как в WMS (ui/theme.tsx).
// `id` различает экземпляры (меню и мобильная панель), иначе общий layoutId
// анимировал бы подложку между ними.
export function ThemeToggle({ id = 'theme' }) {
  const [theme, setTheme] = useTheme()
  return (
    <div className="relative inline-flex rounded-full border border-line bg-surface-2 p-0.5" role="radiogroup" aria-label="Тема">
      {OPTIONS.map(({ value, Icon, label }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          title={label}
          onClick={() => setTheme(value)}
          className={`relative z-10 grid h-7 w-8 place-items-center rounded-full transition-colors ${theme === value ? 'text-ink' : 'text-muted-foreground hover:text-ink-2'}`}
        >
          {theme === value && (
            <motion.span
              layoutId={`${id}-pill`}
              className="absolute inset-0 -z-10 rounded-full bg-surface shadow-card"
              transition={{ type: 'spring', stiffness: 500, damping: 35 }}
            />
          )}
          <Icon size={15} />
        </button>
      ))}
    </div>
  )
}
