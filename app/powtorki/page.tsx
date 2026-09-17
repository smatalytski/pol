'use client'
import { useCallback, useEffect, useRef, useReducer, useState } from 'react'
import { ReviewCard } from '@/components/ReviewCard'
import { currentCard, initialReviewState, reviewReducer } from '@/hooks/useReviewSession'
import type { RatingValue } from '@/lib/scheduler'
import { t } from '@/i18n/pl'

export default function ReviewPage() {
  const [state, dispatch] = useReducer(reviewReducer, initialReviewState)
  const [nextDue, setNextDue] = useState<number | null>(null)
  const [reviewedCount, setReviewedCount] = useState(0)
  // Important review finding (A3): a rejected rating POST was previously
  // ignored outright — the optimistic UI had already advanced past the card,
  // so the user had no way to know the rating never reached the server.
  const [rateError, setRateError] = useState(false)
  // Distinguishes "still fetching the queue" from "fetched, and it's empty."
  // Without this, `card` is null and `reviewedCount` is 0 during the initial
  // fetch too, and the empty-queue screen (`t.noCards`) would flash on every
  // load before the real queue arrives.
  const [loaded, setLoaded] = useState(false)
  const shownAt = useRef(Date.now())
  const card = currentCard(state)

  // Guards against a fast double-tap recording the same rating twice: rating
  // is not idempotent (two "dobrze" pushes the card twice as far out).
  // Cleared once the in-flight request settles, not on card change, so it
  // also throttles a rating fired while the previous one is still in flight.
  const rateInFlight = useRef(false)
  const undoInFlight = useRef(false)

  useEffect(() => {
    void fetch('/api/review/queue')
      .then((r) => r.json())
      .then((d) => {
        dispatch({ type: 'loaded', queue: d.cards })
        setNextDue(d.nextDue ?? null)
        setLoaded(true)
      })
  }, [])

  useEffect(() => {
    shownAt.current = Date.now()
  }, [card?.id])

  const rate = useCallback(
    (rating: RatingValue) => {
      if (!card || rateInFlight.current) return
      rateInFlight.current = true
      const durationMs = Date.now() - shownAt.current
      dispatch({ type: 'rate' })
      setReviewedCount((n) => n + 1)
      setRateError(false)
      void fetch(`/api/review/${card.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating, durationMs }),
      })
        .then((res) => {
          if (!res.ok) setRateError(true)
        })
        .finally(() => {
          rateInFlight.current = false
        })
    },
    [card],
  )

  const undo = useCallback(() => {
    if (!state.lastRated || undoInFlight.current) return
    // `undoLastReview` acts on the globally-last non-undone review row — it
    // has no notion of "this client" or "this session's queue". With a
    // second writer (another tab, another device on the same Tailscale
    // network) it's possible for this client to optimistically restore card
    // X while the server actually reverted a different card, Y, rated from
    // elsewhere a moment later. Capture which card *this* undo expects
    // before dispatching, so the response can be checked against it rather
    // than trusted just because it came back non-null.
    const expectedCardId = state.lastRated.id
    undoInFlight.current = true
    dispatch({ type: 'undo' })
    setReviewedCount((n) => Math.max(0, n - 1))
    void fetch('/api/review/undo', { method: 'POST' })
      .then((r) => r.json())
      .then((d) => {
        // Either "nothing was undone" (log empty, or already undone by the
        // time this ran) or "the wrong card was undone" (a second writer's
        // review became the globally-last one first) makes the client's
        // optimistic revert a lie. Reload from the server's truth rather
        // than leave the UI showing a card that wasn't actually reverted —
        // or was, but isn't the one now sitting at the front of the queue.
        if (!d.undone || d.undone.cardId !== expectedCardId) {
          return fetch('/api/review/queue')
            .then((r2) => r2.json())
            .then((q) => {
              dispatch({ type: 'loaded', queue: q.cards })
              setNextDue(q.nextDue ?? null)
            })
        }
      })
      .finally(() => {
        undoInFlight.current = false
      })
  }, [state.lastRated])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Scoped to this screen's lifetime (the effect is torn down on
      // navigation) and skipped while focus is on any text input — there is
      // none on this screen today, but a stray focused control (browser
      // autofill, a future element) shouldn't have every keystroke hijacked
      // as a rating. Modifier combos are left alone too, so Ctrl/Cmd+Z and
      // browser/OS shortcuts on 1-4 keep working normally.
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === ' ') {
        e.preventDefault()
        dispatch({ type: 'reveal' })
      } else if (state.revealed && ['1', '2', '3', '4'].includes(e.key)) {
        rate(Number(e.key) as RatingValue)
      } else if (e.key === 'z') {
        undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.revealed, rate, undo])

  if (!card) {
    if (!loaded) return null

    // Nothing was ever queued this session (no cards due, no new cards to
    // introduce) versus a session that just finished are different messages:
    // the former is "there's nothing to review", the latter is "you're done,
    // here's what happened and when to come back".
    if (reviewedCount === 0) {
      return (
        <div className="p-8 text-center">
          <p className="text-xl">{t.noCards}</p>
        </div>
      )
    }
    return (
      <div className="p-8 text-center">
        {rateError && <p className="text-sm text-red-600">{t.rateFailed}</p>}
        <p className="text-xl">{t.doneForToday}</p>
        <p className="mt-2 text-sm text-neutral-500">
          {t.sessionReviewed}: {reviewedCount}
        </p>
        {nextDue != null && (
          <p className="mt-1 text-sm text-neutral-500">
            {t.nextReviewAt}: {new Date(nextDue).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' })}
          </p>
        )}
        {state.lastRated && (
          <button onClick={undo} className="mt-4 text-sm underline">
            {t.undo}
          </button>
        )}
      </div>
    )
  }

  return (
    <>
      {rateError && (
        <p className="p-2 text-center text-sm text-red-600">{t.rateFailed}</p>
      )}
      <ReviewCard
        card={card}
        revealed={state.revealed}
        canUndo={state.lastRated !== null}
        onReveal={() => dispatch({ type: 'reveal' })}
        onRate={rate}
        onUndo={undo}
      />
    </>
  )
}
