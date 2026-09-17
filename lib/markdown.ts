/**
 * A small hand-rolled renderer for what the `pl_forms` generator actually
 * emits (spec §5): bold spans and pipe tables. Nothing more.
 *
 * Deliberately NOT a general Markdown parser — headings, links, lists, code
 * fences and nesting are all out of scope on purpose. Scope creep here is
 * exactly how "a few dozen lines" becomes "400 lines and a dependency we
 * should have just taken." If the generator's prompt ever grows to emit more
 * Markdown constructs, extend this file's tests first, deliberately, rather
 * than generalizing preemptively.
 *
 * This module only ever produces data (`MarkdownBlock[]`) — no DOM, no HTML
 * strings, nothing that could be handed to `dangerouslySetInnerHTML`. The
 * input is model output, which is untrusted; building React elements from
 * plain text (see components/FormsTable.tsx) means React escapes it like any
 * other text node, with no chance of it being interpreted as markup.
 */

export type InlineSegment = { text: string; bold: boolean }
export type TableBlock = { type: 'table'; rows: InlineSegment[][][] }
export type ParagraphBlock = { type: 'paragraph'; content: InlineSegment[] }
export type MarkdownBlock = TableBlock | ParagraphBlock

// A pipe-table's separator row, e.g. `|---|---|` or `| :--- | ---: |`. Rows
// made up entirely of these cells are the divider between header and body,
// not data, and are dropped.
const SEPARATOR_CELL = /^:?-+:?$/

/**
 * Splits inline text into bold/plain segments. `**text**` pairs become bold;
 * anything else — including an unclosed `**` with no matching close, which
 * this regex simply never matches — passes through as literal plain text.
 * Never throws: there is no input shape this can fail to produce a segment
 * list for.
 */
function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = []
  const re = /\*\*([^*]+?)\*\*/g
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > lastIndex) segments.push({ text: text.slice(lastIndex, m.index), bold: false })
    segments.push({ text: m[1], bold: true })
    lastIndex = re.lastIndex
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), bold: false })
  return segments.length > 0 ? segments : [{ text: '', bold: false }]
}

function isTableRowCandidate(line: string): boolean {
  return line.includes('|')
}

/** Splits one table row into raw cell strings, dropping the leading/trailing empty cell a `| a | b |`-style line produces. */
function splitCells(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => SEPARATOR_CELL.test(c))
}

export function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let buffer: string[] = []

  function flushBuffer() {
    if (buffer.length === 0) return
    // A real table (per what the generator emits) is a header row plus a
    // separator row, so anything shorter than two candidate lines is not a
    // table — most commonly a single line of prose that happens to contain a
    // stray `|`. Falling back to a paragraph per buffered line, rather than
    // silently dropping them, is what keeps malformed input safe: nothing
    // written by the model ever vanishes from the rendered output.
    if (buffer.length >= 2) {
      const rows = buffer
        .map(splitCells)
        .filter((cells) => !isSeparatorRow(cells))
        .map((cells) => cells.map(parseInline))
      if (rows.length > 0) {
        blocks.push({ type: 'table', rows })
        buffer = []
        return
      }
    }
    for (const line of buffer) {
      if (line.trim() !== '') blocks.push({ type: 'paragraph', content: parseInline(line) })
    }
    buffer = []
  }

  for (const raw of lines) {
    if (isTableRowCandidate(raw)) {
      buffer.push(raw)
      continue
    }
    flushBuffer()
    if (raw.trim() !== '') blocks.push({ type: 'paragraph', content: parseInline(raw) })
  }
  flushBuffer()

  return blocks
}
