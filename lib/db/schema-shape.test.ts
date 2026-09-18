import { describe, expect, it } from 'vitest'
import { createTestDb } from './testing'

describe('schema after migrations', () => {
  it('has the card columns the forms design needs, and none of the removed ones', () => {
    const { sqlite } = createTestDb()
    const cols = (sqlite.prepare('PRAGMA table_info(cards)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['type', 'word_kind', 'forms_json', 'deleted_at']))
    expect(cols).not.toContain('prompt_media_id')
    expect(cols).not.toContain('parent_card_id')
  })

  // Squashed once, on 2026-09-18, because the database was dropped (spec §4).
  it('is a single squashed migration', () => {
    const { sqlite } = createTestDb()
    const names = (sqlite.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name)
    expect(names).toEqual(['001-init.sql'])
  })
})
