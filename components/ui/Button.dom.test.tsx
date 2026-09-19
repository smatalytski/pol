// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button, buttonClass } from './Button'
import { Plus, Trash2 } from './icons'

afterEach(cleanup)

describe('Button', () => {
  it('shows a primary button as a filled black icon + word', () => {
    render(<Button variant="primary" icon={Plus} label="dodaj" />)
    const button = screen.getByRole('button', { name: 'dodaj' })
    expect(button.textContent).toBe('dodaj')
    expect(button.className).toContain('bg-black')
    expect(button.getAttribute('type')).toBe('button')
    expect(button.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
    expect(button.querySelector('svg')!.getAttribute('width')).toBe('18')
  })

  it('shows a secondary button outlined, with its word', () => {
    render(<Button variant="secondary" icon={Plus} label="przywróć" />)
    const button = screen.getByRole('button', { name: 'przywróć' })
    expect(button.textContent).toBe('przywróć')
    expect(button.className).toContain('border')
    expect(button.className).not.toContain('bg-black')
  })

  it('names an icon-only button by its label, as aria-label and tooltip', () => {
    render(<Button variant="icon" icon={Plus} label="anuluj" />)
    const button = screen.getByRole('button', { name: 'anuluj' })
    expect(button.textContent).toBe('')
    expect(button.getAttribute('title')).toBe('anuluj')
  })

  it('renders danger red, icon-only only when asked', () => {
    render(
      <>
        <Button variant="danger" icon={Trash2} label="usuń" iconOnly />
        <Button variant="danger" icon={Trash2} label="przenieś do odrzuconych" />
      </>,
    )
    const only = screen.getByRole('button', { name: 'usuń' })
    expect(only.textContent).toBe('')
    expect(only.className).toContain('text-red-600')
    const worded = screen.getByRole('button', { name: 'przenieś do odrzuconych' })
    expect(worded.textContent).toBe('przenieś do odrzuconych')
    expect(worded.getAttribute('aria-label')).toBeNull()
  })

  it('lets getByText reach the <button> itself', () => {
    render(<Button variant="secondary" icon={Plus} label="ponów" disabled />)
    expect((screen.getByText('ponów') as HTMLButtonElement).disabled).toBe(true)
  })

  it('disables a busy button and swaps its icon for a spinner', () => {
    const onClick = vi.fn()
    render(<Button variant="primary" icon={Plus} label="jeszcze" busy onClick={onClick} />)
    const button = screen.getByRole('button', { name: 'jeszcze' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    const svgs = button.querySelectorAll('svg')
    expect(svgs).toHaveLength(1)
    expect(svgs[0].getAttribute('class')).toContain('animate-spin')
    expect(svgs[0].getAttribute('class')).toContain('motion-reduce:animate-none')
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('passes other button attributes and handlers through', () => {
    const onPointerDown = vi.fn()
    render(<Button variant="secondary" label="x" type="submit" aria-pressed onPointerDown={onPointerDown} className="self-end" />)
    const button = screen.getByRole('button', { name: 'x' })
    expect(button.getAttribute('type')).toBe('submit')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.className).toContain('self-end')
    fireEvent.pointerDown(button)
    expect(onPointerDown).toHaveBeenCalled()
  })

  it('sizes sm at 32px and md at 40px; icon-only buttons are square', () => {
    expect(buttonClass('primary', 'sm')).toContain('h-8')
    expect(buttonClass('primary', 'md')).toContain('h-10')
    expect(buttonClass('icon', 'sm')).toContain('w-8')
    expect(buttonClass('icon', 'md')).toContain('w-10')
    expect(buttonClass('danger', 'sm', true)).toContain('w-8')
  })
})
