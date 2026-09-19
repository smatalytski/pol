import type { LucideIcon } from './icons'

/** One icon at the app's size and weight; always decorative — the control around it carries the name. */
export function Icon({ icon: Glyph, size = 20, className }: { icon: LucideIcon; size?: number; className?: string }) {
  return <Glyph size={size} strokeWidth={2} aria-hidden="true" focusable="false" className={className} />
}
