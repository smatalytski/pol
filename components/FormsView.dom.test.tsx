// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FormsView } from './FormsView'
import { t } from '@/i18n/pl'

afterEach(cleanup)

const NOUN = {
  basic: [{ label: 'M. l.mn.', value: 'koty' }, { label: 'D. l.poj.', value: 'kota' }],
  extended: [{ label: 'C.', value: 'kotu · kotom' }],
}

describe('FormsView', () => {
  it('shows the basic forms', () => {
    render(<FormsView forms={NOUN} />)
    expect(screen.getByText('M. l.mn.')).toBeTruthy()
    expect(screen.getByText('koty')).toBeTruthy()
    expect(screen.getByText('kota')).toBeTruthy()
  })

  it('hides the extended forms until asked, then hides them again', () => {
    render(<FormsView forms={NOUN} />)
    expect(screen.queryByText('kotu · kotom')).toBeNull()
    fireEvent.click(screen.getByText(t.showAllForms))
    expect(screen.getByText('kotu · kotom')).toBeTruthy()
    fireEvent.click(screen.getByText(t.hideAllForms))
    expect(screen.queryByText('kotu · kotom')).toBeNull()
  })

  it('offers no toggle when there are no extended forms', () => {
    render(<FormsView forms={{ basic: NOUN.basic, extended: [] }} />)
    expect(screen.queryByText(t.showAllForms)).toBeNull()
  })

  it('renders nothing without forms', () => {
    const { container } = render(<FormsView forms={null} />)
    expect(container.innerHTML).toBe('')
  })
})
