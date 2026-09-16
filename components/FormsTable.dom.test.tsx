// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FormsTable } from './FormsTable'

describe('FormsTable', () => {
  // B6 (test-integrity finding): `queryByText('**pies**')` can never match
  // anything either way — a correctly-parsed bold segment renders as just
  // "pies" (no asterisks) inside a <strong>, and even a totally broken
  // parser that left the markdown unparsed would render the whole string
  // "**pies** → o **psie**" as one run, which doesn't equal the substring
  // "**pies**" under queryByText's exact-match default. Assert directly on
  // the rendered text instead: no literal `**` survives anywhere, and the
  // two bold words are the only <strong> elements.
  it('renders bold spans as <strong>, not literal asterisks', () => {
    const { container } = render(<FormsTable markdown="**pies** → o **psie**" />)
    expect(container.textContent).not.toContain('**')
    const strongs = screen.getAllByText(/pies|psie/)
    expect(strongs.map((el) => el.tagName)).toEqual(['STRONG', 'STRONG'])
  })

  it('renders a pipe table as an actual <table>, dropping the separator row', () => {
    const md = ['| Osoba | Teraźniejszy |', '|---|---|', '| ja | robię |'].join('\n')
    render(<FormsTable markdown={md} />)
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getByText('Osoba')).toBeTruthy()
    expect(screen.getByText('robię')).toBeTruthy()
    expect(screen.queryByText(/^---$/)).toBeNull()
  })

  it('does not throw and renders something on malformed input (missing cell, unclosed bold, stray pipe)', () => {
    for (const md of [
      ['| a | b | c |', '|---|---|---|', '| 1 | 2 |'].join('\n'),
      '**unclosed bold marker',
      'a stray | pipe in prose',
      '',
    ]) {
      expect(() => render(<FormsTable markdown={md} />)).not.toThrow()
    }
  })

  it('never injects raw HTML — a literal `<script>` in the model output renders as inert text', () => {
    render(<FormsTable markdown="<script>alert(1)</script>" />)
    expect(document.querySelector('script')).toBeNull()
    expect(screen.getByText('<script>alert(1)</script>')).toBeTruthy()
  })
})
