'use client'
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Button } from './Button'
import { X } from './icons'
import { t } from '@/i18n/pl'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * A full-screen overlay (spec 2026-09-20 §7.2), the app's only one. It covers
 * the page rather than dimming it, so there is no backdrop to tap: it closes
 * on Escape and on `zamknij`.
 *
 * Focus moves to the dialog on open and back to whatever opened it on close,
 * and Tab is trapped in between — without that, tabbing walks into the page
 * underneath, which is still rendered and still clickable to a screen reader.
 * Body scroll is locked for the same reason: a phone otherwise scrolls the
 * page behind the sheet.
 */
export function Sheet({
  open,
  label,
  onClose,
  children,
}: {
  open: boolean
  label: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement as HTMLElement | null
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    ref.current?.focus()
    return () => {
      document.body.style.overflow = previous
      openerRef.current?.focus()
    }
  }, [open])

  if (!open) return null

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === ref.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (active === last || active === ref.current)) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-30 overflow-y-auto bg-background"
    >
      <div className="mx-auto flex max-w-xl flex-col gap-3 p-4">
        {children}
        <Button variant="secondary" size="md" icon={X} label={t.sheetClose} onClick={onClose} className="self-start" />
      </div>
    </div>
  )
}
