// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sheet } from './Sheet'
import { t } from '@/i18n/pl'

afterEach(cleanup)

describe('Sheet', () => {
  it('renders nothing when closed', () => {
    render(<Sheet open={false} label="tematy" onClose={vi.fn()}><p>hello</p></Sheet>)
    expect(screen.queryByText('hello')).toBeNull()
  })

  it('is a labelled modal dialog when open', () => {
    render(<Sheet open label="tematy" onClose={vi.fn()}><p>hello</p></Sheet>)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('tematy')
  })

  it('closes on Escape and on the close button', () => {
    const onClose = vi.fn()
    render(<Sheet open label="tematy" onClose={onClose}><p>hello</p></Sheet>)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText(t.sheetClose))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('takes focus on open and locks the page behind it', () => {
    const { rerender } = render(<Sheet open={false} label="tematy" onClose={vi.fn()}><button>inside</button></Sheet>)
    expect(document.body.style.overflow).not.toBe('hidden')
    rerender(<Sheet open label="tematy" onClose={vi.fn()}><button>inside</button></Sheet>)
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
    expect(document.body.style.overflow).toBe('hidden')
  })

  it('gives the page back its scroll when it closes', () => {
    const { rerender } = render(<Sheet open label="tematy" onClose={vi.fn()}><p>hello</p></Sheet>)
    rerender(<Sheet open={false} label="tematy" onClose={vi.fn()}><p>hello</p></Sheet>)
    expect(document.body.style.overflow).not.toBe('hidden')
  })

  it('keeps Tab inside the sheet', () => {
    render(
      <Sheet open label="tematy" onClose={vi.fn()}>
        <button>first</button>
      </Sheet>,
    )
    const close = screen.getByText(t.sheetClose)
    close.focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByText('first'))
  })
})
