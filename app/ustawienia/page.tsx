'use client'
import { useEffect, useState } from 'react'
import { t } from '@/i18n/pl'

type Settings = {
  newPerDay: number
  requestRetention: number
  audioGapSeconds: number
  audioRepeatAnswer: number
  audioExample: number
  audioHint: number
  audioRepeatExample: number
  audioNextSeconds: number
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  // Draft values for the controls below, separate from `settings` (the last
  // known-good value the server has confirmed). Important review finding
  // (A3): these inputs used to be uncontrolled `defaultValue`s, so a value
  // the server rejected (e.g. requestRetention outside 0.7-0.98) stayed on
  // screen looking accepted. Making them controlled from `settings` and only
  // ever advancing the draft on a successful PUT means a rejected value
  // reverts to the last confirmed one instead of lingering. The two
  // checkboxes save on change rather than on blur, but follow the same
  // draft/revert shape.
  const [newPerDayDraft, setNewPerDayDraft] = useState('')
  const [retentionDraft, setRetentionDraft] = useState('')
  const [gapDraft, setGapDraft] = useState('')
  const [nextDraft, setNextDraft] = useState('')
  const [repeatDraft, setRepeatDraft] = useState(false)
  const [exampleDraft, setExampleDraft] = useState(false)
  const [hintDraft, setHintDraft] = useState(false)
  const [repeatExampleDraft, setRepeatExampleDraft] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json())
      .then((s: Settings) => {
        setSettings(s)
        setNewPerDayDraft(String(s.newPerDay))
        setRetentionDraft(String(s.requestRetention))
        setGapDraft(String(s.audioGapSeconds))
        setNextDraft(String(s.audioNextSeconds))
        setRepeatDraft(s.audioRepeatAnswer === 1)
        setExampleDraft(s.audioExample === 1)
        setHintDraft(s.audioHint === 1)
        setRepeatExampleDraft(s.audioRepeatExample === 1)
      })
  }, [])

  async function save(patch: Record<string, number>) {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    // Cross-field clobber guard (re-review finding on A3): only ever touch
    // the draft(s) for the field(s) this specific `save()` call actually
    // sent. Each control calls `save` with just its own key — without this
    // scoping, blurring/changing field A (an async PUT) while the user is
    // already mid-edit on field B, then having A's response land, would
    // overwrite B's uncommitted draft with the server's stale pre-edit
    // value, silently discarding it. That is exactly the class of bug A3
    // was written to close, just reintroduced across more fields.
    if (!res.ok) {
      setError(true)
      // Revert only the just-attempted field's draft to the last confirmed
      // value, rather than leaving the rejected input on screen.
      if (settings) {
        if ('newPerDay' in patch) setNewPerDayDraft(String(settings.newPerDay))
        if ('requestRetention' in patch) setRetentionDraft(String(settings.requestRetention))
        if ('audioGapSeconds' in patch) setGapDraft(String(settings.audioGapSeconds))
        if ('audioNextSeconds' in patch) setNextDraft(String(settings.audioNextSeconds))
        if ('audioRepeatAnswer' in patch) setRepeatDraft(settings.audioRepeatAnswer === 1)
        if ('audioExample' in patch) setExampleDraft(settings.audioExample === 1)
        if ('audioHint' in patch) setHintDraft(settings.audioHint === 1)
        if ('audioRepeatExample' in patch) setRepeatExampleDraft(settings.audioRepeatExample === 1)
      }
      return
    }
    setError(false)
    const s = (await res.json()) as Settings
    setSettings(s)
    if ('newPerDay' in patch) setNewPerDayDraft(String(s.newPerDay))
    if ('requestRetention' in patch) setRetentionDraft(String(s.requestRetention))
    if ('audioGapSeconds' in patch) setGapDraft(String(s.audioGapSeconds))
    if ('audioNextSeconds' in patch) setNextDraft(String(s.audioNextSeconds))
    if ('audioRepeatAnswer' in patch) setRepeatDraft(s.audioRepeatAnswer === 1)
    if ('audioExample' in patch) setExampleDraft(s.audioExample === 1)
    if ('audioHint' in patch) setHintDraft(s.audioHint === 1)
    if ('audioRepeatExample' in patch) setRepeatExampleDraft(s.audioRepeatExample === 1)
  }

  if (!settings) return null

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="text-sm text-red-600">{t.settingsSaveFailed}</p>}
      <label className="flex flex-col gap-1">
        {t.newPerDay}
        <input
          type="number"
          min={0}
          max={200}
          value={newPerDayDraft}
          onChange={(e) => setNewPerDayDraft(e.target.value)}
          onBlur={() => void save({ newPerDay: Number(newPerDayDraft) })}
          className="rounded border p-3"
        />
      </label>
      <label className="flex flex-col gap-1">
        {t.targetRetention}
        <input
          type="number"
          step={0.01}
          min={0.7}
          max={0.98}
          value={retentionDraft}
          onChange={(e) => setRetentionDraft(e.target.value)}
          onBlur={() => void save({ requestRetention: Number(retentionDraft) })}
          className="rounded border p-3"
        />
      </label>

      <div className="flex flex-col gap-4">
        <h2 className="text-lg">{t.listenSection}</h2>
        <label className="flex flex-col gap-1">
          {t.listenGap}
          <input
            type="number"
            min={1}
            max={30}
            value={gapDraft}
            onChange={(e) => setGapDraft(e.target.value)}
            onBlur={() => void save({ audioGapSeconds: Number(gapDraft) })}
            className="rounded border p-3"
          />
        </label>
        <label className="flex flex-col gap-1">
          {t.listenNext}
          <input
            type="number"
            min={1}
            max={30}
            value={nextDraft}
            onChange={(e) => setNextDraft(e.target.value)}
            onBlur={() => void save({ audioNextSeconds: Number(nextDraft) })}
            className="rounded border p-3"
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={repeatDraft}
            onChange={(e) => {
              setRepeatDraft(e.target.checked)
              void save({ audioRepeatAnswer: e.target.checked ? 1 : 0 })
            }}
          />
          {t.listenRepeat}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={exampleDraft}
            onChange={(e) => {
              setExampleDraft(e.target.checked)
              void save({ audioExample: e.target.checked ? 1 : 0 })
            }}
          />
          {t.listenExample}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={hintDraft}
            onChange={(e) => {
              setHintDraft(e.target.checked)
              void save({ audioHint: e.target.checked ? 1 : 0 })
            }}
          />
          {t.listenHint}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={repeatExampleDraft}
            onChange={(e) => {
              setRepeatExampleDraft(e.target.checked)
              void save({ audioRepeatExample: e.target.checked ? 1 : 0 })
            }}
          />
          {t.listenRepeatExample}
        </label>
      </div>
    </div>
  )
}
