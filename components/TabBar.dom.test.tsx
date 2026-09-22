// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { t } from '@/i18n/pl'

let pathname = '/powtorki'
vi.mock('next/navigation', () => ({ usePathname: () => pathname }))
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

const { TabBar } = await import('./TabBar')

beforeEach(() => {
  pathname = '/powtorki'
})
afterEach(cleanup)

describe('TabBar', () => {
  it('shows six tabs in order, each linking to its section', () => {
    render(<TabBar />)
    const links = screen.getAllByRole('link')
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/powtorki', '/sluchaj', '/dodaj', '/tematy', '/fiszki', '/ustawienia',
    ])
    expect(links.map((l) => l.textContent)).toEqual([
      t.review, t.listen, t.add, t.topics, t.cards, t.settingsTab,
    ])
  })

  it('names the settings tab in full although it shows the short label', () => {
    render(<TabBar />)
    expect(screen.getByRole('link', { name: t.settings }).getAttribute('href')).toBe('/ustawienia')
  })

  it('draws an icon on every tab', () => {
    render(<TabBar />)
    for (const link of screen.getAllByRole('link')) expect(link.querySelector('svg')).not.toBeNull()
  })

  it('marks the current section, including on its sub-pages', () => {
    pathname = '/tematy/abc'
    render(<TabBar />)
    expect(screen.getByRole('link', { name: t.topics }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: t.review }).getAttribute('aria-current')).toBeNull()
    expect(screen.getAllByRole('link').filter((l) => l.getAttribute('aria-current') === 'page')).toHaveLength(1)
  })

  it('puts tematy beside dodaj, in the thumb zone', () => {
    render(<TabBar />)
    const labels = screen.getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(labels).toEqual(['/powtorki', '/sluchaj', '/dodaj', '/tematy', '/fiszki', '/ustawienia'])
  })

  // jsdom has no layout engine: these pin the mechanism. The bar is fixed to
  // the viewport's bottom and pads itself clear of the phone's gesture bar.
  it('is fixed to the bottom and pads for the safe area', () => {
    render(<TabBar />)
    const nav = screen.getByRole('navigation')
    expect(nav.className).toContain('fixed')
    expect(nav.className).toContain('bottom-0')
    expect(nav.className).toContain('pad-safe-bottom')
  })
})
