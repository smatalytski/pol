import type { ReactNode } from 'react'

const TONE = { neutral: 'text-neutral-600', sky: 'text-sky-700', amber: 'text-amber-700' } as const

/** A small rounded pill for a row's status words (spec 2026-09-19-ui-icons §5). Keeps each badge's existing text colour. */
export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof TONE; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-xs ${TONE[tone]}`}>{children}</span>
}
