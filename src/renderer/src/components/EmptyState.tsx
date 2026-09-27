import type { ReactNode } from 'react'
import { Icon } from './icons'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  desc?: ReactNode
  actions?: ReactNode
}

export function EmptyState({
  icon = <Icon name="monitor" size={26} />,
  title,
  desc,
  actions
}: EmptyStateProps): JSX.Element {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <div className="empty-title">{title}</div>
      {desc ? <div className="empty-desc">{desc}</div> : null}
      {actions ? <div className="empty-actions">{actions}</div> : null}
    </div>
  )
}
