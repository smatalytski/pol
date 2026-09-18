/**
 * Word forms carried on a card (spec 2026-09-18 §3–§4). Pure: no database, no
 * React, so the server, the review screen and the tests share one definition.
 */

export const WORD_KINDS = ['fraza', 'rzeczownik', 'czasownik', 'przymiotnik', 'przyslowek', 'inne'] as const
export type WordKind = (typeof WORD_KINDS)[number]

export type FormRow = { label: string; value: string }
export type CardForms = { basic: FormRow[]; extended: FormRow[] }

const WITH_FORMS: ReadonlySet<WordKind> = new Set(['rzeczownik', 'czasownik', 'przymiotnik', 'przyslowek'])

/** Whether a word of this kind has forms at all. `null` is an unclassified card. */
export function hasForms(kind: WordKind | null): boolean {
  return kind !== null && WITH_FORMS.has(kind)
}

/** `null` when there is nothing to store, so "no forms" has one representation. */
export function serializeForms(forms: CardForms): string | null {
  if (forms.basic.length === 0 && forms.extended.length === 0) return null
  return JSON.stringify(forms)
}

function isRow(r: unknown): r is FormRow {
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof (r as FormRow).label === 'string' &&
    typeof (r as FormRow).value === 'string'
  )
}

const rows = (x: unknown): FormRow[] => (Array.isArray(x) ? x.filter(isRow) : [])

/**
 * Tolerant on purpose: `forms_json` is only written by this app, but the review
 * screen reads it on every card, and a corrupt value must cost that card its
 * forms rather than crash the session.
 */
export function parseForms(json: string | null): CardForms | null {
  if (!json) return null
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const forms = { basic: rows((v as CardForms).basic), extended: rows((v as CardForms).extended) }
  return forms.basic.length === 0 && forms.extended.length === 0 ? null : forms
}

/**
 * Whether a card can be a pl_to_pl card: its whole answer is its forms, so it
 * needs a kind that has forms AND stored forms that read back as non-empty. One
 * rule for both `setCardType` (switching to pl_to_pl) and `applyGeneratedFields`
 * (reverting a pl_to_pl card a regeneration left without forms).
 */
export function canDrillForms(kind: WordKind | null, formsJson: string | null): boolean {
  return hasForms(kind) && parseForms(formsJson) !== null
}
