// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n/pl'
import { RoundSettings } from './RoundSettings'

afterEach(cleanup)

describe('RoundSettings', () => {
  it('offers exactly 5, 10 and 20, and reports a change', () => {
    const onChange = vi.fn()
    render(<RoundSettings value={{ count: 10, mix: 'mieszane' }} onChange={onChange} />)
    const select = screen.getByLabelText(t.roundCount) as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(['5', '10', '20'])
    fireEvent.change(select, { target: { value: '20' } })
    expect(onChange).toHaveBeenCalledWith({ count: 20, mix: 'mieszane' })
  })

  it('switches the mix, marking the current one', () => {
    const onChange = vi.fn()
    render(<RoundSettings value={{ count: 10, mix: 'slowa' }} onChange={onChange} />)
    expect(screen.getByRole('button', { name: t.mixWords }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: t.mixPhrases }))
    expect(onChange).toHaveBeenCalledWith({ count: 10, mix: 'frazy' })
  })
})
