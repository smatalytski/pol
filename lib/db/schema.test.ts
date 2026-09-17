import { describe, expect, it } from 'vitest'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { createTestDb } from './testing'
import * as schema from './schema'
import { media, cards, reviews, captures, ttsClips, settings } from './schema'

describe('schema', () => {
  it('creates every table', () => {
    const { sqlite } = createTestDb()
    const names = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name)
    expect(names).toEqual(
      expect.arrayContaining(['media', 'cards', 'reviews', 'captures', 'tts_clips', 'settings']),
    )
  })

  it.each([media, cards, reviews, captures, ttsClips, settings])(
    'drizzle definition matches the SQL for %s',
    (table) => {
      const { sqlite } = createTestDb()
      const actual = sqlite
        .prepare(`PRAGMA table_info(${getTableName(table)})`)
        .all()
        .map((r) => (r as { name: string }).name)
        .sort()
      const declared = Object.values(getTableColumns(table)).map((c) => c.name).sort()
      expect(declared).toEqual(actual)
    },
  )

  it('indexes the due queue', () => {
    const { sqlite } = createTestDb()
    const idx = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r) => (r as { name: string }).name)
    expect(idx).toEqual(expect.arrayContaining(['cards_due', 'cards_answer_key', 'reviews_card']))
  })

  it('exports nothing unexpected', () => {
    expect(Object.keys(schema).sort()).toEqual(
      ['captures', 'cards', 'media', 'reviews', 'settings', 'ttsClips'].sort(),
    )
  })
})
