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
    expect(names).toEqual([
      '001-init.sql', '002-generation-queue.sql', '003-topics.sql', '004-capture-lang.sql',
      '005-topic-items.sql', '006-listening.sql', '007-prompt-commas.sql',
      '008-login-throttle.sql',
    ])
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

  it('has topics and topic items, and topic columns on cards, captures and jobs', () => {
    const { sqlite } = createTestDb()
    const cols = (table: string) =>
      (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
    expect(cols('topics')).toEqual(['id', 'name', 'context', 'suspended_at', 'created_at', 'is_default'])
    expect(cols('topic_items')).toEqual([
      'id', 'topic_id', 'answer_pl', 'gloss_ru', 'kind', 'source', 'level', 'status',
      'capture_id', 'card_id', 'batch_job_id', 'discarded_at', 'created_at',
    ])
    expect(cols('cards')).toContain('topic_id')
    expect(cols('captures')).toEqual(expect.arrayContaining(['topic_id', 'gloss_ru']))
  })

  // DELETE /api/captures/:id hard-deletes a recording with no card. An item
  // must not block that, and must not point at a missing row.
  it("clears an item's capture when the capture is deleted", () => {
    const { sqlite } = createTestDb()
    sqlite.prepare(`INSERT INTO topics (id, context, created_at) VALUES ('t1', 'x', 1)`).run()
    sqlite.prepare(`INSERT INTO captures (id, status, created_at) VALUES ('c1', 'queued', 1)`).run()
    sqlite
      .prepare(`INSERT INTO topic_items (id, topic_id, answer_pl, source, status, capture_id, created_at)
                VALUES ('i1', 't1', 'katar', 'suggested', 'carded', 'c1', 1)`)
      .run()
    sqlite.prepare(`DELETE FROM captures WHERE id = 'c1'`).run()
    expect(sqlite.prepare(`SELECT capture_id FROM topic_items`).get()).toEqual({ capture_id: null })
  })

  it('has card_audio table with the correct columns', () => {
    const { sqlite } = createTestDb()
    const cols = (sqlite.prepare('PRAGMA table_info(card_audio)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(['key', 'media_id', 'duration_ms', 'created_at'])
  })

  it('has listens table with the correct columns', () => {
    const { sqlite } = createTestDb()
    const cols = (sqlite.prepare('PRAGMA table_info(listens)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(['id', 'card_id', 'heard_at'])
  })

  it('fails to insert a listens row for an unknown card with foreign keys ON', () => {
    const { sqlite } = createTestDb()
    expect(() => {
      sqlite.prepare(`INSERT INTO listens (card_id, heard_at) VALUES ('unknown-card', 1)`).run()
    }).toThrow()
  })

  it('upgrades 004 to topic items: a default topic, every card in a topic, suggestions mapped', () => {
    const sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    for (const f of ['001-init.sql', '002-generation-queue.sql', '003-topics.sql', '004-capture-lang.sql']) {
      sqlite.exec(readFileSync(join(process.cwd(), 'migrations', f), 'utf8'))
    }
    sqlite.exec(`CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
    sqlite.prepare(`INSERT INTO _migrations VALUES ('001-init.sql',1),('002-generation-queue.sql',1),('003-topics.sql',1),('004-capture-lang.sql',1)`).run()
    const card = sqlite.prepare(`INSERT INTO cards (id, type, answer_pl, answer_key, status, created_at, updated_at, due, deleted_at, topic_id)
      VALUES (?, 'ru_to_pl', ?, ?, 'ready', 1, 1, 1, ?, ?)`)
    sqlite.prepare(`INSERT INTO topics (id, name, context, created_at) VALUES ('t1', 'U lekarza', 'x', 1)`).run()
    card.run('live', 'kot', 'kot', null, null)
    card.run('gone', 'pies', 'pies', 5, null)
    card.run('topical', 'katar', 'katar', null, 't1')
    sqlite.prepare(`INSERT INTO captures (id, status, created_at, card_id) VALUES ('c1', 'generated', 1, 'topical')`).run()
    const sug = sqlite.prepare(`INSERT INTO suggestions (id, topic_id, round, answer_pl, gloss_ru, kind, status, capture_id, created_at)
      VALUES (?, 't1', 1, ?, 'g', 'slowo', ?, ?, 1)`)
    sug.run('p', 'gorączka', 'proposed', null)
    sug.run('a', 'katar', 'accepted', 'c1')
    sug.run('r', 'kaszel', 'rejected', null)

    migrate(sqlite)

    expect(sqlite.prepare(`SELECT id, name, is_default FROM topics WHERE is_default = 1`).all()).toEqual([
      { id: 'default', name: 'Ogólne', is_default: 1 },
    ])
    expect(sqlite.prepare(`SELECT id, topic_id FROM cards ORDER BY id`).all()).toEqual([
      { id: 'gone', topic_id: 'default' },
      { id: 'live', topic_id: 'default' },
      { id: 'topical', topic_id: 't1' },
    ])
    expect(sqlite.prepare(`SELECT id, status, source, level, card_id, discarded_at IS NOT NULL AS d FROM topic_items ORDER BY id`).all()).toEqual([
      { id: 'a', status: 'carded', source: 'suggested', level: 'zaawansowany', card_id: 'topical', d: 0 },
      { id: 'p', status: 'open', source: 'suggested', level: 'zaawansowany', card_id: null, d: 0 },
      { id: 'r', status: 'discarded', source: 'suggested', level: 'zaawansowany', card_id: null, d: 1 },
    ])
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE name = 'suggestions'`).get()).toBeUndefined()
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

    // 003 added the column empty; 005 files every topic-less card under Ogólne.
    expect(sqlite.prepare('SELECT id, topic_id FROM cards').all()).toEqual([{ id: 'k1', topic_id: 'default' }])
  })

  // Spec 2026-09-19-hands-free-audio-design.md §3.2/part D: existing
  // questions get the one-time slash-to-comma cleanup on upgrade.
  it('upgrades a database at 006, rewriting prompt_text slashes to commas and leaving answers untouched', () => {
    const sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    for (const f of [
      '001-init.sql', '002-generation-queue.sql', '003-topics.sql',
      '004-capture-lang.sql', '005-topic-items.sql', '006-listening.sql',
    ]) {
      sqlite.exec(readFileSync(join(process.cwd(), 'migrations', f), 'utf8'))
    }
    sqlite.exec(`CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
    sqlite
      .prepare(
        `INSERT INTO _migrations VALUES
          ('001-init.sql',1),('002-generation-queue.sql',1),('003-topics.sql',1),
          ('004-capture-lang.sql',1),('005-topic-items.sql',1),('006-listening.sql',1)`,
      )
      .run()

    const card = sqlite.prepare(`INSERT INTO cards (id, type, prompt_text, answer_pl, answer_key, status, created_at, updated_at, due)
      VALUES (?, 'ru_to_pl', ?, ?, ?, 'ready', 1, 1, 1)`)
    card.run('a', 'a / b', 'ans-a', 'key-a')
    card.run('b', 'a/b', 'ans-b', 'key-b')
    card.run('c', 'a /b', 'ans-c', 'key-c')
    card.run('d', 'a/ b', 'ans-d', 'key-d')
    card.run('e', 'a, b', 'ans-e', 'key-e')
    card.run('f', null, 'ans-f', 'key-f')

    migrate(sqlite)

    const rows = sqlite.prepare(`SELECT id, prompt_text, answer_pl, answer_key FROM cards ORDER BY id`).all()
    expect(rows).toEqual([
      { id: 'a', prompt_text: 'a, b', answer_pl: 'ans-a', answer_key: 'key-a' },
      { id: 'b', prompt_text: 'a, b', answer_pl: 'ans-b', answer_key: 'key-b' },
      { id: 'c', prompt_text: 'a, b', answer_pl: 'ans-c', answer_key: 'key-c' },
      { id: 'd', prompt_text: 'a, b', answer_pl: 'ans-d', answer_key: 'key-d' },
      { id: 'e', prompt_text: 'a, b', answer_pl: 'ans-e', answer_key: 'key-e' },
      { id: 'f', prompt_text: null, answer_pl: 'ans-f', answer_key: 'key-f' },
    ])
  })
})
