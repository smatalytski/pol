// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n/pl'
import { ManualAddBar } from './ManualAddBar'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ManualAddBar', () => {
  it('adds the trimmed text and clears the field when onAdd resolves to null', async () => {
    const onAdd = vi.fn().mockResolvedValue(null)
    const onChange = vi.fn()
    const { rerender } = render(<ManualAddBar value="  kubek  " onChange={onChange} onAdd={onAdd} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: t.addItem }))
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith('kubek'))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(''))
    rerender(<ManualAddBar value="" onChange={onChange} onAdd={onAdd} onClose={() => {}} />)
    expect((screen.getByLabelText(t.manualAdd) as HTMLInputElement).value).toBe('')
  })

  it('disables dodaj when the text is empty', () => {
    render(<ManualAddBar value="" onChange={() => {}} onAdd={vi.fn()} onClose={() => {}} />)
    expect((screen.getByRole('button', { name: t.addItem }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('has no microphones: dictation goes through the recording screen', () => {
    render(<ManualAddBar value="" onChange={() => {}} onAdd={async () => null} onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: t.recordPolish })).toBeNull()
    expect(screen.queryByRole('button', { name: t.recordRussian })).toBeNull()
  })

  it('reports what the server refused', async () => {
    render(<ManualAddBar value="kot" onChange={() => {}} onAdd={async () => 'już masz — w temacie Ogólne'} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: t.addItem }))
    expect(await screen.findByText('już masz — w temacie Ogólne')).toBeTruthy()
  })

  it('closes without adding when cancelled', () => {
    const onClose = vi.fn()
    const onAdd = vi.fn()
    render(<ManualAddBar value="kot" onChange={() => {}} onAdd={onAdd} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: t.cancel }))
    expect(onClose).toHaveBeenCalled()
    expect(onAdd).not.toHaveBeenCalled()
  })
})
