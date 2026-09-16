'use client'
import { useEffect, useState } from 'react'
import { t } from '@/i18n/pl'

type Settings = { newPerDay: number; requestRetention: number }

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  // Draft strings for the two inputs, separate from `settings` (the last
  // known-good value the server has confirmed). Important review finding
  // (A3): these inputs used to be uncontrolled `defaultValue`s, so a value
  // the server rejected (e.g. requestRetention outside 0.7-0.98) stayed on
  // screen looking accepted. Making them controlled from `settings` and only
  // ever advancing the draft on a successful PUT means a rejected value
  // reverts to the last confirmed one instead of lingering.
  const [newPerDayDraft, setNewPerDayDraft] = useState('')
  const [retentionDraft, setRetentionDraft] = useState('')
  const [error, setError] = useState(false)

  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json())
      .then((s: Settings) => {
        setSettings(s)
        setNewPerDayDraft(String(s.newPerDay))
        setRetentionDraft(String(s.requestRetention))
      })
  }, [])

  async function save(patch: Record<string, number>) {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) {
      setError(true)
      // Revert the drafts to the last confirmed value rather than leaving
      // the rejected input on screen.
      if (settings) {
        setNewPerDayDraft(String(settings.newPerDay))
        setRetentionDraft(String(settings.requestRetention))
      }
      return
    }
    setError(false)
    const s = (await res.json()) as Settings
    setSettings(s)
    setNewPerDayDraft(String(s.newPerDay))
    setRetentionDraft(String(s.requestRetention))
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
    </div>
  )
}
