// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n/pl'
import { BatchSettings } from './BatchSettings'

afterEach(cleanup)

describe('BatchSettings', () => {
  it('offers exactly 5, 10 and 20, and reports a change', () => {
    const onChange = vi.fn()
    render(<BatchSettings value={{ count: 10, mix: 'mieszane', level: 'zaawansowany' }} onChange={onChange} />)
    const select = screen.getByLabelText(t.roundCount) as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(['5', '10', '20'])
    fireEvent.change(select, { target: { value: '20' } })
    expect(onChange).toHaveBeenCalledWith({ count: 20, mix: 'mieszane', level: 'zaawansowany' })
  })

  it('switches the mix among mieszane · tylko słowa · tylko frazy, marking the current one', () => {
    const onChange = vi.fn()
    render(<BatchSettings value={{ count: 10, mix: 'slowa', level: 'zaawansowany' }} onChange={onChange} />)
    expect(screen.getByRole('button', { name: t.mixMixed }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: t.mixWords }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: t.mixPhrases }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: t.mixPhrases }))
    expect(onChange).toHaveBeenCalledWith({ count: 10, mix: 'frazy', level: 'zaawansowany' })
  })

  it('switches the level between zaawansowany and średniozaawansowany, marking the current one', () => {
    const onChange = vi.fn()
    render(<BatchSettings value={{ count: 10, mix: 'mieszane', level: 'sredni' }} onChange={onChange} />)
    expect(screen.getByRole('button', { name: t.levelAdvanced }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: t.levelIntermediate }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: t.levelAdvanced }))
    expect(onChange).toHaveBeenCalledWith({ count: 10, mix: 'mieszane', level: 'zaawansowany' })
  })
})
