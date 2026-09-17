import { describe, expect, it } from 'vitest'
import { parseMarkdown } from './markdown'

describe('parseMarkdown', () => {
  it('renders plain text as a single unbolded paragraph', () => {
    expect(parseMarkdown('hello')).toEqual([
      { type: 'paragraph', content: [{ text: 'hello', bold: false }] },
    ])
  })

  it('splits bold spans out of a paragraph', () => {
    expect(parseMarkdown('**pies** → o **psie**')).toEqual([
      {
        type: 'paragraph',
        content: [
          { text: 'pies', bold: true },
          { text: ' → o ', bold: false },
          { text: 'psie', bold: true },
        ],
      },
    ])
  })

  it('parses a pipe table into rows of cells, dropping the separator row', () => {
    const md = ['| Osoba | Teraźniejszy |', '|---|---|', '| ja | robię |', '| ty | robisz |'].join('\n')
    expect(parseMarkdown(md)).toEqual([
      {
        type: 'table',
        rows: [
          [[{ text: 'Osoba', bold: false }], [{ text: 'Teraźniejszy', bold: false }]],
          [[{ text: 'ja', bold: false }], [{ text: 'robię', bold: false }]],
          [[{ text: 'ty', bold: false }], [{ text: 'robisz', bold: false }]],
        ],
      },
    ])
  })

  it('renders bold text inside table cells', () => {
    const md = ['| a | b |', '|---|---|', '| **x** | y |'].join('\n')
    const blocks = parseMarkdown(md)
    expect(blocks).toEqual([
      {
        type: 'table',
        rows: [
          [[{ text: 'a', bold: false }], [{ text: 'b', bold: false }]],
          [[{ text: 'x', bold: true }], [{ text: 'y', bold: false }]],
        ],
      },
    ])
  })

  it('mixes a leading paragraph with a following table', () => {
    const md = ['przyzwyczaić się — formy', '| a | b |', '|---|---|', '| 1 | 2 |'].join('\n')
    const blocks = parseMarkdown(md)
    expect(blocks[0]).toEqual({
      type: 'paragraph',
      content: [{ text: 'przyzwyczaić się — formy', bold: false }],
    })
    expect(blocks[1].type).toBe('table')
  })

  it('does not throw on a missing cell (ragged rows)', () => {
    const md = ['| a | b | c |', '|---|---|---|', '| 1 | 2 |'].join('\n')
    expect(() => parseMarkdown(md)).not.toThrow()
    const table = parseMarkdown(md)[0]
    expect(table).toEqual({
      type: 'table',
      rows: [
        [[{ text: 'a', bold: false }], [{ text: 'b', bold: false }], [{ text: 'c', bold: false }]],
        [[{ text: '1', bold: false }], [{ text: '2', bold: false }]],
      ],
    })
  })

  it('does not throw on an unclosed bold marker, and shows it literally', () => {
    const md = '**pies → o psie'
    expect(() => parseMarkdown(md)).not.toThrow()
    expect(parseMarkdown(md)).toEqual([
      { type: 'paragraph', content: [{ text: '**pies → o psie', bold: false }] },
    ])
  })

  it('does not treat a stray single pipe in prose as a one-row table', () => {
    const md = 'stosunek 5 | 3 na korzyść'
    expect(parseMarkdown(md)).toEqual([
      { type: 'paragraph', content: [{ text: 'stosunek 5 | 3 na korzyść', bold: false }] },
    ])
  })

  it('returns an empty list for an empty string, without throwing', () => {
    expect(() => parseMarkdown('')).not.toThrow()
    expect(parseMarkdown('')).toEqual([])
  })

  it('does not throw on a table made up only of separator rows', () => {
    const md = ['|---|---|', '|---|---|'].join('\n')
    expect(() => parseMarkdown(md)).not.toThrow()
  })
})
