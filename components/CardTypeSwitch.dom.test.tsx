// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CardTypeSwitch } from './CardTypeSwitch'
import { t } from '@/i18n/pl'

afterEach(cleanup)

describe('CardTypeSwitch', () => {
  it('marks the current type and offers the other as a button', () => {
    render(<CardTypeSwitch type="ru_to_pl" onChange={vi.fn()} />)
    expect(screen.getByText(t.typeRuPl).tagName).not.toBe('BUTTON')
    expect(screen.getByText(t.typePlPl).tagName).toBe('BUTTON')
  })

  it('asks for the other type', () => {
    const onChange = vi.fn()
    render(<CardTypeSwitch type="ru_to_pl" onChange={onChange} />)
    fireEvent.click(screen.getByText(t.typePlPl))
    expect(onChange).toHaveBeenCalledWith('pl_to_pl')
  })

  it('asks to switch back', () => {
    const onChange = vi.fn()
    render(<CardTypeSwitch type="pl_to_pl" onChange={onChange} />)
    fireEvent.click(screen.getByText(t.typeRuPl))
    expect(onChange).toHaveBeenCalledWith('ru_to_pl')
  })
})
