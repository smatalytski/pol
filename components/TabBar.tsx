'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Icon } from '@/components/ui/Icon'
import { Headphones, Layers, List, Mic, RotateCcw, Settings, type LucideIcon } from '@/components/ui/icons'
import { t } from '@/i18n/pl'

const TABS: ReadonlyArray<{ href: string; label: string; short?: string; icon: LucideIcon }> = [
  { href: '/powtorki', label: t.review, icon: RotateCcw },
  { href: '/sluchaj', label: t.listen, icon: Headphones },
  { href: '/dodaj', label: t.add, icon: Mic },
  { href: '/fiszki', label: t.cards, icon: Layers },
  { href: '/tematy', label: t.topics, icon: List },
  { href: '/ustawienia', label: t.settings, short: t.settingsTab, icon: Settings },
]

/**
 * The app's navigation (spec 2026-09-19-ui-icons §3.4): six icon + label tabs
 * fixed to the bottom, where the thumb is. The current section is the route's
 * first path segment, so /tematy/abc still lights up Tematy. Fixed elements
 * ignore the body's `max-w-xl`, so the inner list re-centres itself; the
 * layout's `pad-below-tabbar` keeps page content from ending up underneath.
 */
export function TabBar() {
  const section = `/${(usePathname() ?? '').split('/')[1] ?? ''}`
  return (
    <nav className="pad-safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-neutral-200 bg-background">
      <ul className="tabbar-h mx-auto grid max-w-xl grid-cols-6">
        {TABS.map((tab) => {
          const current = section === tab.href
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={current ? 'page' : undefined}
                aria-label={tab.short ? tab.label : undefined}
                className={`flex h-full flex-col items-center justify-center gap-0.5 text-xs ${current ? 'font-bold' : 'text-neutral-500'}`}
              >
                <span className={`flex h-7 w-12 items-center justify-center rounded-full ${current ? 'bg-neutral-200 text-neutral-900' : ''}`}>
                  <Icon icon={tab.icon} />
                </span>
                {tab.short ?? tab.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
