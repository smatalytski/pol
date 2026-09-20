/**
 * An on/off toggle (spec 2026-09-19-ui-icons §3.3). A native <button>, so Space
 * and Enter already click it; `role="switch"` + `aria-checked` say what it is.
 * The name is always `label` (aria-label); `showLabel` also prints it beside
 * the track, for the full-width rows in Ustawienia.
 */
export function Switch({
  checked,
  onChange,
  label,
  showLabel = false,
  disabled = false,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  showLabel?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`inline-flex min-h-8 items-center gap-3 disabled:opacity-40 ${showLabel ? 'w-full justify-between text-left' : ''}`}
    >
      {showLabel && <span>{label}</span>}
      <span
        aria-hidden="true"
        className={`relative inline-block h-6 w-10 shrink-0 rounded-full transition-colors motion-reduce:transition-none ${checked ? 'bg-primary' : 'bg-neutral-300'}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${checked ? 'translate-x-4' : ''}`}
        />
      </span>
    </button>
  )
}
