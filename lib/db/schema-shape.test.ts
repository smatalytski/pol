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
    expect(names).toEqual(['001-init.sql', '002-generation-queue.sql', '003-topics.sql', '004-capture-lang.sql'])
  })

  it('gives captures a recognition language', () => {
    const { sqlite } = createTestDb()
    const cols = (sqlite.prepare('PRAGMA table_info(captures)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('lang')
  })

  // Re-recognition is removed (spec 2026-09-18-recording-language §4): a
  // `rerecognized` job still waiting at upgrade time would reach a worker with
  // no handler for it. Finished ones stay as history.
  it('fails queued and running rerecognized jobs on upgrade, leaving the rest', () => {
    const sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    for (const f of ['001-init.sql', '002-generation-queue.sql', '003-topics.sql']) {
      sqlite.exec(readFileSync(join(process.cwd(), 'migrations', f), 'utf8'))
    }
    sqlite.exec(`CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
    sqlite.prepare(`INSERT INTO _migrations VALUES ('001-init.sql', 1), ('002-generation-queue.sql', 1), ('003-topics.sql', 1)`).run()
    const job = sqlite.prepare(`INSERT INTO generation_jobs (id, kind, status, next_attempt_at, created_at) VALUES (?, ?, ?, 1, 1)`)
    job.run('q', 'rerecognized', 'queued')
    job.run('r', 'rerecognized', 'running')
    job.run('d', 'rerecognized', 'done')
    job.run('n', 'new', 'queued')
    sqlite.prepare(`INSERT INTO captures (id, status, created_at) VALUES ('c1', 'generated', 1)`).run()

    migrate(sqlite)

    const rows = sqlite.prepare(`SELECT id, status, last_error, finished_at IS NOT NULL AS finished FROM generation_jobs ORDER BY id`).all()
    expect(rows).toEqual([
      { id: 'd', status: 'done', last_error: null, finished: 0 },
      { id: 'n', status: 'queued', last_error: null, finished: 0 },
      { id: 'q', status: 'failed', last_error: 're-recognition removed', finished: 1 },
      { id: 'r', status: 'failed', last_error: 're-recognition removed', finished: 1 },
    ])
    expect(sqlite.prepare(`SELECT lang FROM captures`).get()).toEqual({ lang: null })
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
      'id', 'kind', 'capture_id', 'card_id', 'status', 'attempts', 'failures',
      'next_attempt_at', 'last_error', 'created_at', 'finished_at', 'topic_id', 'params_json',
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

  it('has topics and suggestions, and topic columns on cards, captures and jobs', () => {
    const { sqlite } = createTestDb()
    const cols = (table: string) =>
      (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
    expect(cols('topics')).toEqual(['id', 'name', 'context', 'suspended_at', 'created_at'])
    expect(cols('suggestions')).toEqual([
      'id', 'topic_id', 'round', 'answer_pl', 'gloss_ru', 'kind', 'status', 'capture_id', 'created_at',
    ])
    expect(cols('cards')).toContain('topic_id')
    expect(cols('captures')).toEqual(expect.arrayContaining(['topic_id', 'gloss_ru']))
  })

  // DELETE /api/captures/:id hard-deletes a recording with no card. A
  // suggestion must not block that, and must not point at a missing row.
  it("clears a suggestion's capture when the capture is deleted", () => {
    const { sqlite } = createTestDb()
    sqlite.prepare(`INSERT INTO topics (id, context, created_at) VALUES ('t1', 'x', 1)`).run()
    sqlite.prepare(`INSERT INTO captures (id, status, created_at) VALUES ('c1', 'queued', 1)`).run()
    sqlite
      .prepare(`INSERT INTO suggestions (id, topic_id, round, answer_pl, gloss_ru, kind, status, capture_id, created_at)
                VALUES ('s1', 't1', 1, 'katar', 'насморк', 'slowo', 'accepted', 'c1', 1)`)
      .run()
    sqlite.prepare(`DELETE FROM captures WHERE id = 'c1'`).run()
    expect(sqlite.prepare(`SELECT capture_id FROM suggestions`).get()).toEqual({ capture_id: null })
  })

  it('upgrades a database that has 002 applied, keeping its cards', () => {
    const sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    for (const f of ['001-init.sql', '002-generation-queue.sql']) {
      sqlite.exec(readFileSync(join(process.cwd(), 'migrations', f), 'utf8'))
    }
    sqlite.exec(`CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
    sqlite.prepare(`INSERT INTO _migrations VALUES ('001-init.sql', 1), ('002-generation-queue.sql', 1)`).run()
    sqlite
      .prepare(`INSERT INTO cards (id, type, answer_pl, answer_key, status, created_at, updated_at, due, stability,
                difficulty, elapsed_days, scheduled_days, reps, lapses, state)
                VALUES ('k1', 'ru_to_pl', 'kot', 'kot', 'ready', 1, 1, 1, 0, 0, 0, 0, 0, 0, 0)`)
      .run()

    migrate(sqlite)

    expect(sqlite.prepare('SELECT id, topic_id FROM cards').all()).toEqual([{ id: 'k1', topic_id: null }])
  })
})
