// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { CardRow } from '@/lib/cards/service'
import { CardListItem } from './CardListItem'

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

afterEach(cleanup)

const card = { id: 'k1', answerPl: 'katar', status: 'ready', suspendedAt: null, type: 'ru_to_pl' } as CardRow

describe('CardListItem actions', () => {
  it('renders actions beside the link, not inside it, so a button click does not navigate', () => {
    const onClick = vi.fn()
    render(
      <ul>
        <CardListItem card={card} actions={<button type="button" onClick={onClick}>zrób coś</button>} />
      </ul>,
    )
    const button = screen.getByRole('button', { name: 'zrób coś' })
    expect(button.closest('a')).toBeNull()
    const li = screen.getByText('katar').closest('li')!
    expect(li.contains(button)).toBe(true)
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders no actions container when none is given', () => {
    render(
      <ul>
        <CardListItem card={card} />
      </ul>,
    )
    expect(screen.queryByRole('button')).toBeNull()
  })
})
