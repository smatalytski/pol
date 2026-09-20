'use client'
import { useEffect, useState } from 'react'
import { t } from '@/i18n/pl'
import { Switch } from '@/components/ui/Switch'

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

/**
 * One settings row: the name on the left, a compact number on the right, so
 * a number reads like the switches below it rather than like a form field.
 * The `<label>` wraps the input, so `getByLabelText` still finds it.
 */
function NumberRow({
  label, value, onChange, onCommit, ...input
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onCommit: () => void
} & Pick<React.InputHTMLAttributes<HTMLInputElement>, 'min' | 'max' | 'step'>) {
  return (
    <label className="flex items-center justify-between gap-3 text-sub">
      <span>{label}</span>
      <input
        type="number"
        {...input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        className="w-20 rounded-lg border border-neutral-300 px-3 py-2 text-right text-base"
      />
    </label>
  )
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  // Draft values for the controls below, separate from `settings` (the last
  // known-good value the server has confirmed). Important review finding
  // (A3): these inputs used to be uncontrolled `defaultValue`s, so a value
  // the server rejected (e.g. requestRetention outside 0.7-0.98) stayed on
  // screen looking accepted. Making them controlled from `settings` and only
  // ever advancing the draft on a successful PUT means a rejected value
  // reverts to the last confirmed one instead of lingering. The four
  // switches save on change rather than on blur, but follow the same
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
    <div className="flex flex-col gap-4">
      {error && <p className="text-sm text-red-600">{t.settingsSaveFailed}</p>}
      <h2 className="mt-2 text-xl font-bold">{t.settingsGeneral}</h2>
      <NumberRow
        label={t.newPerDay}
        min={0}
        max={200}
        value={newPerDayDraft}
        onChange={setNewPerDayDraft}
        onCommit={() => void save({ newPerDay: Number(newPerDayDraft) })}
      />
      <NumberRow
        label={t.targetRetention}
        step={0.01}
        min={0.7}
        max={0.98}
        value={retentionDraft}
        onChange={setRetentionDraft}
        onCommit={() => void save({ requestRetention: Number(retentionDraft) })}
      />

      <div className="flex flex-col gap-4">
        <h2 className="mt-2 text-xl font-bold">{t.listenSection}</h2>
        <NumberRow
          label={t.listenGap}
          min={1}
          max={30}
          value={gapDraft}
          onChange={setGapDraft}
          onCommit={() => void save({ audioGapSeconds: Number(gapDraft) })}
        />
        <NumberRow
          label={t.listenNext}
          min={1}
          max={30}
          value={nextDraft}
          onChange={setNextDraft}
          onCommit={() => void save({ audioNextSeconds: Number(nextDraft) })}
        />
        <Switch
          showLabel
          checked={repeatDraft}
          label={t.listenRepeat}
          onChange={(on) => {
            setRepeatDraft(on)
            void save({ audioRepeatAnswer: on ? 1 : 0 })
          }}
        />
        <Switch
          showLabel
          checked={exampleDraft}
          label={t.listenExample}
          onChange={(on) => {
            setExampleDraft(on)
            void save({ audioExample: on ? 1 : 0 })
          }}
        />
        <Switch
          showLabel
          checked={hintDraft}
          label={t.listenHint}
          onChange={(on) => {
            setHintDraft(on)
            void save({ audioHint: on ? 1 : 0 })
          }}
        />
        <Switch
          showLabel
          checked={repeatExampleDraft}
          label={t.listenRepeatExample}
          onChange={(on) => {
            setRepeatExampleDraft(on)
            void save({ audioRepeatExample: on ? 1 : 0 })
          }}
        />
      </div>
    </div>
  )
}
