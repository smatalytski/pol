// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { Nav } from './Nav'

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

afterEach(cleanup)

describe('Nav', () => {
  // Every other tab label is capitalised (Powtórki, Fiszki, Tematy,
  // Ustawienia) — t.add must match, not read like ManualAddBar's lowercase
  // "dodaj" button (that action has its own key, t.addItem).
  it('labels the /dodaj tab "Dodaj", capitalised like the other tabs', () => {
    render(<Nav />)
    const link = screen.getByRole('link', { name: 'Dodaj' })
    expect(link.getAttribute('href')).toBe('/dodaj')
  })

  it('puts Słuchaj between Powtórki and Dodaj', () => {
    render(<Nav />)
    const links = screen.getAllByRole('link').map((l) => l.textContent)
    const review = links.indexOf('Powtórki')
    const listen = links.indexOf('Słuchaj')
    const add = links.indexOf('Dodaj')
    expect(review).toBeGreaterThanOrEqual(0)
    expect(listen).toBe(review + 1)
    expect(add).toBe(listen + 1)
    expect(screen.getByRole('link', { name: 'Słuchaj' }).getAttribute('href')).toBe('/sluchaj')
  })
})
