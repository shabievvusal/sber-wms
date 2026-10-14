import { Toaster as Sonner } from 'sonner'
import { useResolvedTheme } from '@/lib/theme'

function Toaster(props) {
  const theme = useResolvedTheme()
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      toastOptions={{ style: { borderRadius: '16px', boxShadow: 'var(--shadow-lg)' } }}
      style={{
        '--normal-bg': 'var(--popover)',
        '--normal-text': 'var(--popover-foreground)',
        '--normal-border': 'var(--border)',
      }}
      {...props}
    />
  )
}

export { Toaster }
