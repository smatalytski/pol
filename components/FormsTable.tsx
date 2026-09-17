import { parseMarkdown, type InlineSegment } from '@/lib/markdown'

function Inline({ segments }: { segments: InlineSegment[] }) {
  return (
    <>
      {segments.map((seg, i) => (seg.bold ? <strong key={i}>{seg.text}</strong> : <span key={i}>{seg.text}</span>))}
    </>
  )
}

/**
 * Renders a `pl_forms` card's answer — a small Markdown subset (bold + pipe
 * tables, see lib/markdown.ts) — as real elements instead of literal
 * `**pies** → o **psie**` syntax. Builds React elements from plain text
 * rather than using `dangerouslySetInnerHTML`: the input is model output, and
 * React escapes text children by default, so nothing here can be interpreted
 * as markup.
 */
export function FormsTable({ markdown }: { markdown: string }) {
  const blocks = parseMarkdown(markdown)
  return (
    <div className="flex flex-col items-start gap-2 text-left">
      {blocks.map((block, i) =>
        block.type === 'table' ? (
          <table key={i} className="w-full border-collapse text-base">
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="border-b">
                  {row.map((cell, c) => (
                    <td key={c} className="p-1">
                      <Inline segments={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p key={i}>
            <Inline segments={block.content} />
          </p>
        ),
      )}
    </div>
  )
}
