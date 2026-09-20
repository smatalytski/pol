'use client'
import { useState } from 'react'
import { t } from '@/i18n/pl'

export default function LoginPage() {
  const [password, setPassword] = useState('')
  const [failed, setFailed] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (res.ok) window.location.href = '/powtorki'
    else setFailed(true)
  }

  return (
    <form onSubmit={submit} className="mx-auto flex max-w-sm flex-col gap-4 p-8">
      <input
        type="password"
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="rounded-lg border border-neutral-300 p-4 text-lg"
        placeholder={t.passwordPlaceholder}
      />
      <button type="submit" className="rounded-lg bg-primary p-4 text-lg text-white">
        {t.logIn}
      </button>
      {failed && <p className="text-red-600">{t.badPassword}</p>}
    </form>
  )
}
