'use client'
import { useEffect, useState } from 'react'
import { t } from '@/i18n/pl'

export default function SettingsPage() {
  const [settings, setSettings] = useState<{ newPerDay: number; requestRetention: number } | null>(null)

  useEffect(() => {
    void fetch('/api/settings').then((r) => r.json()).then(setSettings)
  }, [])

  async function save(patch: Record<string, number>) {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    setSettings(await res.json())
  }

  if (!settings) return null

  return (
    <div className="flex flex-col gap-6">
      <label className="flex flex-col gap-1">
        {t.newPerDay}
        <input
          type="number"
          min={0}
          max={200}
          defaultValue={settings.newPerDay}
          onBlur={(e) => void save({ newPerDay: Number(e.target.value) })}
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
          defaultValue={settings.requestRetention}
          onBlur={(e) => void save({ requestRetention: Number(e.target.value) })}
          className="rounded border p-3"
        />
      </label>
    </div>
  )
}
