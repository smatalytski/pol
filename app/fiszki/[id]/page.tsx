'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import type { CardRow, CardType } from '@/lib/cards/service'
import type { DictationLang } from '@/lib/transcribe'
import { hasForms, parseForms } from '@/lib/cards/forms'
import { CardTypeSwitch } from '@/components/CardTypeSwitch'
import { FormsView } from '@/components/FormsView'
import { t } from '@/i18n/pl'

/**
 * Everything editable about one card. The browse list used to carry all of
 * this inline on every row, which left no room for a title-only list and no
 * room for the answer audio player — the control the user went looking for on
 * the list screen, where none existed. A word with forms also shows them here
 * (spec 2026-09-18 §7), with the ru→pl / tylko formy switch alongside.
 */
export default function CardDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [card, setCard] = useState<CardRow | null>(null)
  const [missing, setMissing] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [regenError, setRegenError] = useState(false)
  // The recording this card came from, when there is one. Supplied by the GET
  // so the re-recognition controls are offered only where they can work: a
  // hand-typed card has no audio behind it.
  const [captureId, setCaptureId] = useState<string | null>(null)
  const [langError, setLangError] = useState(false)
  // The re-recognition request runs Speech-to-Text before it answers (the
  // Gemini half is queued), a round trip of a few seconds: without a visible
  // pending state the user taps again and starts a second one on the same
  // capture.
  const [langPending, setLangPending] = useState(false)
  const [typeError, setTypeError] = useState(false)
  const [typeDuplicate, setTypeDuplicate] = useState(false)
  // A queued job (from wygeneruj ponownie or a re-recognition) rewrites this
  // card asynchronously; the GET tells us one is in flight so the page can
  // show that instead of the card looking silently unchanged.
  const [generating, setGenerating] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch(`/api/cards/${id}`)
    if (!res.ok) {
      setMissing(true)
      return
    }
    const body = (await res.json()) as { card: CardRow; captureId?: string | null; generating?: boolean }
    setCard(body.card)
    setCaptureId(body.captureId ?? null)
    setGenerating(body.generating ?? false)
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  // A queued job will rewrite this card (spec 2026-09-18-generation-queue
  // §7.3); reload until it has. The inputs are keyed on server values, so the
  // rebuilt text replaces what is on screen and nothing stale is saved back.
  useEffect(() => {
    if (!generating) return
    const id = setInterval(() => void load(), 2_000)
    return () => clearInterval(id)
  }, [generating, load])

  // Every write goes through here so a rejected one always surfaces: the
  // fields are uncontrolled `defaultValue` inputs, so a silently failed PATCH
  // would leave the edit on screen looking saved.
  async function patch(body: Record<string, unknown>) {
    const res = await fetch(`/api/cards/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      setSaveError(true)
      return
    }
    setSaveError(false)
    setCard(((await res.json()) as { card: CardRow }).card)
  }

  // Queues the rebuild and answers 202 at once (Task 7); Gemini runs in the
  // generation queue, not this request, so there is no rebuilt card to read
  // here — the `generating` poll above picks it up once the job finishes.
  async function regenerate() {
    const res = await fetch(`/api/cards/${id}/regeneruj`, { method: 'POST' })
    if (!res.ok) {
      setRegenError(true)
      return
    }
    setRegenError(false)
    setGenerating(true)
  }

  // A 200 can still carry a clash: the card is left as it was and duplicateOf
  // names the card that already exists (spec 2026-09-18 §6).
  async function setType(type: CardType) {
    const res = await fetch(`/api/cards/${id}/typ`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type }),
    })
    if (!res.ok) {
      setTypeError(true)
      return
    }
    setTypeError(false)
    const body = (await res.json()) as { card: CardRow; duplicateOf: string | null }
    setCard(body.card)
    setTypeDuplicate(body.duplicateOf !== null)
  }

  // Dictation is recognised as Polish, because that is what nearly all of it
  // is: measured on the real API, a two-language recognizer swallows Russian
  // whole (spoken "склеп" came back "sklep", "бешенство" came back
  // "wściekłość"). So a Russian recording is repaired from the stored audio
  // instead — and it has to be the audio, because a wrong-language transcript
  // keeps no trace of what was said, which is why `wygeneruj ponownie` (which
  // re-generates from the stored answer) could never fix it.
  //
  // The route answers 200 with a Speech-to-Text failure in `error`, and with
  // `queued: true` when the card's rebuild is now waiting in the generation
  // queue rather than already done — so checking `res.ok` alone would show
  // nothing when re-recognition fails, and reloading unconditionally would
  // show the pre-rebuild card as if the job had already finished.
  async function relanguage(lang: DictationLang) {
    if (!captureId) return
    setLangPending(true)
    try {
      const res = await fetch(`/api/captures/${captureId}/jezyk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lang }),
      })
      if (!res.ok) {
        setLangError(true)
        return
      }
      const body = (await res.json()) as { queued: boolean; error: string | null }
      setLangError(body.error !== null)
      if (body.queued) setGenerating(true)
      else await load()
    } catch {
      setLangError(true)
    } finally {
      setLangPending(false)
    }
  }

  // Deleting the card this screen is showing would otherwise leave it
  // displaying something that no longer exists.
  async function remove() {
    const res = await fetch(`/api/cards/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      setSaveError(true)
      return
    }
    router.push('/fiszki')
  }

  if (missing) return <p className="text-lg">{t.cardNotFound}</p>
  if (!card) return null

  return (
    <div className="flex flex-col gap-5">
      <Link href="/fiszki" className="text-sm underline">
        {t.backToCards}
      </Link>

      {/* Keyed on the value the server holds, so a card rebuilt underneath
          this screen — by re-recognition or regeneration — remounts the input
          with the new text. `defaultValue` is only read on mount, so without
          this the field would keep displaying the old answer and the next
          blur would PATCH that stale value straight back over the repair.
          Typing does not change card state, so this never remounts mid-edit. */}
      <input
        key={`answer:${card.answerPl}`}
        defaultValue={card.answerPl}
        onBlur={(e) => e.target.value !== card.answerPl && void patch({ answerPl: e.target.value })}
        className="w-full text-2xl font-semibold"
      />

      <audio controls preload="none" src={`/api/cards/${id}/audio?part=answer`} aria-label={t.play} />

      <FormsView key={card.id} forms={parseForms(card.formsJson)} />

      {hasForms(card.wordKind) && <CardTypeSwitch type={card.type} onChange={(type) => void setType(type)} />}

      <label className="flex flex-col gap-1">
        <span className="text-xs uppercase text-neutral-500">{t.detailPrompt}</span>
        <input
          key={`prompt:${card.promptText ?? ''}`}
          defaultValue={card.promptText ?? ''}
          onBlur={(e) =>
            e.target.value !== (card.promptText ?? '') && void patch({ promptText: e.target.value })
          }
          placeholder={t.needsInput}
          className="w-full text-lg"
        />
      </label>

      {card.promptHint && (
        <div>
          <p className="text-xs uppercase text-neutral-500">{t.detailHint}</p>
          <p className="text-sm">{card.promptHint}</p>
        </div>
      )}

      {card.examplePl && (
        <div>
          <p className="text-xs uppercase text-neutral-500">{t.detailExample}</p>
          <p className="text-lg">{card.examplePl}</p>
        </div>
      )}

      {card.grammarNote && (
        <div>
          <p className="text-xs uppercase text-neutral-500">{t.detailGrammar}</p>
          <p className="text-sm">{card.grammarNote}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4 text-sm">
        {card.status === 'needs_input' && (
          <button
            onClick={() => void regenerate()}
            disabled={generating || langPending}
            className="underline disabled:text-neutral-400"
          >
            {t.regenerate}
          </button>
        )}
        <button
          onClick={() => void patch({ suspendedAt: card.suspendedAt ? null : Date.now() })}
          className="underline"
        >
          {card.suspendedAt ? t.unsuspend : t.suspend}
        </button>
        <button onClick={() => void remove()} className="underline text-red-600">
          {t.deleteItem}
        </button>
        {/* A queued job (wygeneruj ponownie or a re-recognition) rewrites this
            card asynchronously, so this can show regardless of whether the
            card has a recording behind it — unlike the language controls
            below, this is not gated on captureId. */}
        {generating && <span className="text-neutral-500">{t.generating}</span>}
      </div>

      {captureId && (
        <div className="flex items-center gap-3 text-sm">
          <span className="text-xs uppercase text-neutral-500">{t.recognizeAs}</span>
          {([
            ['pl', t.asPolish],
            ['ru', t.asRussian],
          ] as const).map(([lang, label]) => (
            <button
              key={lang}
              onClick={() => void relanguage(lang)}
              disabled={langPending || generating}
              className="underline disabled:text-neutral-400"
            >
              {label}
            </button>
          ))}
          {langPending && <span className="text-neutral-500">{t.transcribing}</span>}
        </div>
      )}

      {saveError && <p className="text-sm text-red-600">{t.saveFailed}</p>}
      {regenError && <p className="text-sm text-red-600">{t.regenerateFailed}</p>}
      {langError && <p className="text-sm text-red-600">{t.languageFailed}</p>}
      {typeError && <p className="text-sm text-red-600">{t.typeFailed}</p>}
      {typeDuplicate && <p className="text-sm text-amber-600">{t.typeDuplicate}</p>}
    </div>
  )
}
