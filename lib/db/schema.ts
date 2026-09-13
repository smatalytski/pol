import { blob, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const media = sqliteTable('media', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['image', 'audio', 'tts'] }).notNull(),
  mime: text('mime').notNull(),
  bytes: blob('bytes', { mode: 'buffer' }).notNull(),
  byteSize: integer('byte_size').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const cards = sqliteTable('cards', {
  id: text('id').primaryKey(),
  type: text('type', { enum: ['ru_to_pl', 'image_to_pl', 'pl_forms'] }).notNull(),
  promptText: text('prompt_text'),
  promptHint: text('prompt_hint'),
  promptMediaId: text('prompt_media_id'),
  answerPl: text('answer_pl').notNull(),
  answerKey: text('answer_key').notNull(),
  examplePl: text('example_pl'),
  exampleRu: text('example_ru'),
  grammarNote: text('grammar_note'),
  status: text('status', { enum: ['ready', 'needs_input'] }).notNull(),
  parentCardId: text('parent_card_id'),
  suspendedAt: integer('suspended_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  due: integer('due').notNull(),
  stability: real('stability').notNull(),
  difficulty: real('difficulty').notNull(),
  elapsedDays: integer('elapsed_days').notNull(),
  scheduledDays: integer('scheduled_days').notNull(),
  reps: integer('reps').notNull(),
  lapses: integer('lapses').notNull(),
  state: integer('state').notNull(),
  lastReview: integer('last_review'),
})

export const reviews = sqliteTable('reviews', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  cardId: text('card_id').notNull(),
  rating: integer('rating').notNull(),
  reviewedAt: integer('reviewed_at').notNull(),
  durationMs: integer('duration_ms'),
  stateBefore: text('state_before').notNull(),
  undoneAt: integer('undone_at'),
})

export const captures = sqliteTable('captures', {
  id: text('id').primaryKey(),
  audioMediaId: text('audio_media_id'),
  transcript: text('transcript'),
  status: text('status', { enum: ['uploaded', 'transcribed', 'generated', 'failed'] }).notNull(),
  error: text('error'),
  generationJson: text('generation_json'),
  cardId: text('card_id'),
  createdAt: integer('created_at').notNull(),
})

export const ttsClips = sqliteTable('tts_clips', {
  id: text('id').primaryKey(),
  mediaId: text('media_id').notNull(),
  lang: text('lang', { enum: ['pl', 'ru'] }).notNull(),
  voice: text('voice').notNull(),
  text: text('text').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
