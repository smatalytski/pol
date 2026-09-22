'use client'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Plus, X } from '@/components/ui/icons'
import { t } from '@/i18n/pl'

/**
 * Adding a word to a topic by hand (spec 2026-09-22 §6.1): text only, on the
 * `z kartą` tab, and what you type becomes a card. Dictation left this bar
 * for the recording screen, which now has a topic of its own to file into.
 *
 * The draft lives in the caller, not here: it belongs to the topic page's
 * remembered state, so a trip to /dodaj and back does not eat a half-typed
 * word.
 */
export function ManualAddBar({
  value,
  onChange,
  onAdd,
  onClose,
}: {
  value: string
  onChange: (text: string) => void
  onAdd: (text: string) => Promise<string | null>
  onClose: () => void
}) {
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function add() {
    const trimmed = value.trim()
    if (!trimmed) return
    setBusy(true)
    const error = await onAdd(trimmed)
    setBusy(false)
    setMessage(error)
    // The bar stays open on success, cleared and focused: adding a run of
    // words is the reason it exists. A refusal keeps the word on screen so it
    // can be edited rather than retyped.
    if (!error) onChange('')
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <input
        ref={inputRef}
        aria-label={t.manualAdd}
        placeholder={t.manualPlaceholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-base"
      />
      <div className="flex items-center gap-2">
        <span className="ml-auto flex gap-2">
          <Button variant="primary" icon={Plus} label={t.addItem} disabled={value.trim() === ''} busy={busy} onClick={() => void add()} />
          <Button variant="icon" icon={X} label={t.cancel} onClick={onClose} />
        </span>
      </div>
      {message && <p className="text-sub text-red-600">{message}</p>}
    </div>
  )
}
