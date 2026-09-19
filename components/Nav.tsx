import Link from 'next/link'
import { t } from '@/i18n/pl'

const LINKS = [
  { href: '/powtorki', label: t.review },
  { href: '/sluchaj', label: t.listen },
  { href: '/dodaj', label: t.add },
  { href: '/fiszki', label: t.cards },
  { href: '/tematy', label: t.topics },
  { href: '/ustawienia', label: t.settings },
]

export function Nav() {
  return (
    <nav className="flex flex-wrap gap-x-4 gap-y-2 border-b p-3 text-sm">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className="underline">
          {l.label}
        </Link>
      ))}
    </nav>
  )
}
