import { useApp } from '@/store/useApp'

const ICON: Record<string, string> = {
  info: 'ℹ',
  success: '✓',
  warn: '!',
  danger: '×'
}

export function Toasts(): JSX.Element {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismiss)

  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
          <span className="toast-icon">{ICON[t.kind]}</span>
          <span className="toast-text">{t.text}</span>
        </div>
      ))}
    </div>
  )
}
