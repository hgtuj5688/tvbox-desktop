interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  title?: string
}

export function Switch({ checked, onChange, disabled, title }: SwitchProps): JSX.Element {
  return (
    <button
      type="button"
      className={`switch${checked ? ' on' : ''}`}
      disabled={disabled}
      title={title}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
    />
  )
}
