import type { ButtonHTMLAttributes } from 'react'
import { Icon } from './Icon'
import { LoaderCircle, type LucideIcon } from './icons'

export type ButtonVariant = 'primary' | 'secondary' | 'icon' | 'danger'
export type ButtonSize = 'sm' | 'md'

const BASE =
  'inline-flex shrink-0 select-none items-center justify-center gap-1.5 rounded-lg font-medium disabled:opacity-40'
const LOOK: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-white',
  secondary: 'border border-neutral-300',
  icon: 'border border-neutral-300',
  danger: 'border border-neutral-300 text-red-600',
}
const WORDED: Record<ButtonSize, string> = { sm: 'h-8 px-3 text-sm', md: 'h-10 px-4 text-base' }
const SQUARE: Record<ButtonSize, string> = { sm: 'h-8 w-8', md: 'h-10 w-10' }

/** The classes of a button, for the one place a link has to look like one (Tematy's `nowy temat`). */
export function buttonClass(variant: ButtonVariant, size: ButtonSize = 'sm', iconOnly = variant === 'icon'): string {
  return `${BASE} ${LOOK[variant]} ${iconOnly ? SQUARE[size] : WORDED[size]}`
}

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  variant: ButtonVariant
  /** The visible word, or — icon-only — the accessible name and tooltip. */
  label: string
  icon?: LucideIcon
  size?: ButtonSize
  /** Disables the button and swaps its icon for a spinner while a write is in flight. */
  busy?: boolean
  /** `danger` only: draw it as an icon button rather than a worded one. */
  iconOnly?: boolean
}

/**
 * The one button of spec 2026-09-19-ui-icons §3.2. The label is a bare text
 * node, never wrapped, so `getByText(label)` finds the <button> itself.
 */
export function Button({ variant, label, icon, size = 'sm', busy = false, iconOnly, disabled, type = 'button', className, ...rest }: Props) {
  const onlyIcon = variant === 'icon' || (variant === 'danger' && iconOnly === true)
  const px = size === 'sm' ? 18 : 20
  const glyph = busy ? (
    <Icon icon={LoaderCircle} size={px} className="animate-spin motion-reduce:animate-none" />
  ) : icon ? (
    <Icon icon={icon} size={px} />
  ) : null
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      aria-label={onlyIcon ? label : undefined}
      title={onlyIcon ? label : undefined}
      className={className ? `${buttonClass(variant, size, onlyIcon)} ${className}` : buttonClass(variant, size, onlyIcon)}
    >
      {glyph}
      {onlyIcon ? null : label}
    </button>
  )
}
