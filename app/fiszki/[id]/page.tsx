'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import type { CardRow, CardType } from '@/lib/cards/service'
import { hasForms, parseForms } from '@/lib/cards/forms'
import { CardTypeSwitch } from '@/components/CardTypeSwitch'
import { FormsView } from '@/components/FormsView'
import { MoveToTopic } from '@/components/MoveToTopic'
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
  // The topic this card belongs to, if any, so the detail screen can offer
  // its move picker (`temat: …`) with the right `currentTopicId`.
  const [topic, setTopic] = useState<{ id: string; name: string | null } | null>(null)
  const [typeError, setTypeError] = useState(false)
  const [typeDuplicate, setTypeDuplicate] = useState(false)
  // A queued job (from wygeneruj ponownie) rewrites this card asynchronously;
  // the GET tells us one is in flight so the page can show that instead of
  // the card looking silently unchanged.
  const [generating, setGenerating] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch(`/api/cards/${id}`)
    if (!res.ok) {
      setMissing(true)
      return
    }
    const body = (await res.json()) as {
      card: CardRow
      generating?: boolean
      topic?: { id: string; name: string | null } | null
    }
    setCard(body.card)
    setGenerating(body.generating ?? false)
    setTopic(body.topic ?? null)
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

  // Moving the card this screen is showing to its topic's odrzucone would
  // otherwise leave it displaying a card no longer in view.
  async function remove() {
    const res = await fetch(`/api/cards/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      setSaveError(true)
      return
    }
    router.push('/fiszki')
  }

  // Moving the card to another topic (spec 2026-09-19-topic-items §5.3): a
  // PATCH with only `topicId`, then the page reloads so the move picker's
  // `currentTopicId` catches up with the move.
  async function moveTopic(topicId: string) {
    const res = await fetch(`/api/cards/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topicId }),
    })
    if (!res.ok) {
      setSaveError(true)
      return
    }
    setSaveError(false)
    await load()
  }

  if (missing) return <p className="text-lg">{t.cardNotFound}</p>
  if (!card) return null

  return (
    <div className="flex flex-col gap-5">
      <Link href="/fiszki" className="text-sm underline">
        {t.backToCards}
      </Link>

      {topic && <MoveToTopic currentTopicId={topic.id} onMove={moveTopic} />}

      {/* Keyed on the value the server holds, so a card rebuilt underneath
          this screen — by wygeneruj ponownie — remounts the input with the
          new text. `defaultValue` is only read on mount, so without this the
          field would keep displaying the old answer and the next blur would
          PATCH that stale value straight back over the rebuild. Typing does
          not change card state, so this never remounts mid-edit. */}
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
            disabled={generating}
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
          {t.moveToDiscarded}
        </button>
        {/* wygeneruj ponownie is the only thing that queues a rebuild here
            now that re-recognition is gone, so this shows while a queued or
            running job for this card exists — not only during the request
            that queues it. */}
        {generating && <span className="text-neutral-500">{t.generating}</span>}
      </div>

      {saveError && <p className="text-sm text-red-600">{t.saveFailed}</p>}
      {regenError && <p className="text-sm text-red-600">{t.regenerateFailed}</p>}
      {typeError && <p className="text-sm text-red-600">{t.typeFailed}</p>}
      {typeDuplicate && <p className="text-sm text-amber-600">{t.typeDuplicate}</p>}
    </div>
  )
}
