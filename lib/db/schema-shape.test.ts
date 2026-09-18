import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestDb } from './testing'
import { migrate } from './migrate'

describe('schema after migrations', () => {
  it('has the card columns the forms design needs, and none of the removed ones', () => {
    const { sqlite } = createTestDb()
    const cols = (sqlite.prepare('PRAGMA table_info(cards)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['type', 'word_kind', 'forms_json', 'deleted_at']))
    expect(cols).not.toContain('prompt_media_id')
    expect(cols).not.toContain('parent_card_id')
  })

  // The squash of 2026-09-18 happened once; everything after it appends.
  it('applies the squashed base and then the appended migrations, in order', () => {
    const { sqlite } = createTestDb()
    const names = (sqlite.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]).map((r) => r.name)
    expect(names).toEqual(['001-init.sql', '002-generation-queue.sql'])
  })

  it('gives captures a review timestamp and a recognition-time duplicate', () => {
    const { sqlite } = createTestDb()
    const cols = (sqlite.prepare('PRAGMA table_info(captures)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['transcribed_at', 'duplicate_of']))
  })

  it('has a generation_jobs table with the queue columns', () => {
    const { sqlite } = createTestDb()
    const cols = (sqlite.prepare('PRAGMA table_info(generation_jobs)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual([
      'id', 'kind', 'capture_id', 'card_id', 'status', 'attempts',
      'next_attempt_at', 'last_error', 'created_at', 'finished_at',
    ])
  })

  // DELETE /api/captures/:id hard-deletes a rejected recording. Its job must go
  // with it, or the foreign key refuses the delete.
  it('deletes a recording together with its jobs', () => {
    const { sqlite } = createTestDb()
    sqlite.prepare(`INSERT INTO captures (id, status, created_at) VALUES ('c1', 'queued', 1)`).run()
    sqlite
      .prepare(`INSERT INTO generation_jobs (id, kind, capture_id, status, next_attempt_at, created_at) VALUES ('j1', 'new', 'c1', 'queued', 1, 1)`)
      .run()
    sqlite.prepare(`DELETE FROM captures WHERE id = 'c1'`).run()
    expect(sqlite.prepare('SELECT count(*) AS n FROM generation_jobs').get()).toEqual({ n: 0 })
  })

  // The deployed database already holds data when 002 arrives. A recording
  // caught mid-pipeline by the upgrade ('transcribed' with no review
  // timestamp) must not be stranded outside the review rule.
  it('upgrades a database that already has 001 applied, keeping its rows', () => {
    const sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    sqlite.exec(readFileSync(join(process.cwd(), 'migrations', '001-init.sql'), 'utf8'))
    sqlite.exec(`CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
    sqlite.prepare(`INSERT INTO _migrations VALUES ('001-init.sql', 1)`).run()
    sqlite.prepare(`INSERT INTO captures (id, status, transcript, created_at) VALUES ('old', 'generated', 'kot', 100)`).run()
    sqlite.prepare(`INSERT INTO captures (id, status, transcript, created_at) VALUES ('mid', 'transcribed', 'pies', 200)`).run()

    migrate(sqlite)

    const rows = sqlite.prepare('SELECT id, status, transcribed_at FROM captures ORDER BY id').all()
    expect(rows).toEqual([
      { id: 'mid', status: 'transcribed', transcribed_at: 200 },
      { id: 'old', status: 'generated', transcribed_at: null },
    ])
  })
})
