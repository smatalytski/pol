'use client'
import { useState } from 'react'
import { t } from '@/i18n/pl'

type Result = { name: string; answerPl?: string; duplicateOf?: string | null; error?: string }

export default function ImagesPage() {
  const [results, setResults] = useState<Result[]>([])
  const [busy, setBusy] = useState(false)

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return
    setBusy(true)
    const form = new FormData()
    for (const file of Array.from(files)) form.append('images', file)
    const res = await fetch('/api/images', { method: 'POST', body: form })
    setResults((await res.json()).results)
    setBusy(false)
  }

  return (
    <div className="flex flex-col gap-4">
      <label
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          void upload(e.dataTransfer.files)
        }}
        className="flex h-40 cursor-pointer items-center justify-center rounded border-2 border-dashed"
      >
        {busy ? t.transcribing : t.dropImages}
        <input type="file" accept="image/*" multiple hidden onChange={(e) => void upload(e.target.files)} />
      </label>

      <ul>
        {results.map((r) => (
          <li key={r.name} className="border-b py-2">
            <span className="font-medium">{r.answerPl ?? r.name}</span>
            {r.duplicateOf && <span className="ml-2 text-sm text-amber-600">{t.alreadyHave}</span>}
            {r.error && <span className="ml-2 text-sm text-red-600">{r.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
