// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Switch } from './Switch'

afterEach(cleanup)

describe('Switch', () => {
  it('is a switch named by its label, reporting its state', () => {
    render(<Switch checked label="włączony" onChange={vi.fn()} />)
    const sw = screen.getByRole('switch', { name: 'włączony' })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByLabelText('włączony')).toBe(sw)
  })

  it('asks for the opposite state on click', () => {
    const onChange = vi.fn()
    render(<Switch checked={false} label="Czytaj przykład" onChange={onChange} />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('toggles from the keyboard with Space and Enter', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Switch checked label="Powtórz odpowiedź" onChange={onChange} />)
    screen.getByRole('switch').focus()
    await user.keyboard(' ')
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenNthCalledWith(1, false)
  })

  it('shows its label beside the track only when asked', () => {
    const { rerender } = render(<Switch checked label="Czytaj podpowiedź" onChange={vi.fn()} />)
    expect(screen.getByRole('switch').textContent).toBe('')
    rerender(<Switch checked label="Czytaj podpowiedź" showLabel onChange={vi.fn()} />)
    expect(screen.getByRole('switch').textContent).toBe('Czytaj podpowiedź')
  })

  it('does nothing while disabled', () => {
    const onChange = vi.fn()
    render(<Switch checked label="x" disabled onChange={onChange} />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).not.toHaveBeenCalled()
  })
})
