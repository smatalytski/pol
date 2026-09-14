import Link from 'next/link'
import { t } from '@/i18n/pl'

const LINKS = [
  { href: '/powtorki', label: t.review },
  { href: '/dodaj', label: t.add },
  { href: '/obrazki', label: t.images },
  { href: '/fiszki', label: t.cards },
  { href: '/ustawienia', label: t.settings },
]

export function Nav() {
  return (
    <nav className="flex gap-4 border-b p-3 text-sm">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className="underline">
          {l.label}
        </Link>
      ))}
    </nav>
  )
}
