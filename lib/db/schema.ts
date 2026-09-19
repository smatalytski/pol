import { blob, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { WORD_KINDS } from '../cards/forms'
import { SUGGESTION_KINDS } from '../topics/rounds'

export const media = sqliteTable('media', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['audio', 'tts'] }).notNull(),
  mime: text('mime').notNull(),
  bytes: blob('bytes', { mode: 'buffer' }).notNull(),
  byteSize: integer('byte_size').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const cards = sqliteTable('cards', {
  id: text('id').primaryKey(),
  type: text('type', { enum: ['ru_to_pl', 'pl_to_pl'] }).notNull(),
  promptText: text('prompt_text'),
  promptHint: text('prompt_hint'),
  answerPl: text('answer_pl').notNull(),
  answerKey: text('answer_key').notNull(),
  examplePl: text('example_pl'),
  exampleRu: text('example_ru'),
  grammarNote: text('grammar_note'),
  wordKind: text('word_kind', { enum: WORD_KINDS }),
  formsJson: text('forms_json'),
  status: text('status', { enum: ['ready', 'needs_input'] }).notNull(),
  suspendedAt: integer('suspended_at'),
  deletedAt: integer('deleted_at'),
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
  topicId: text('topic_id'),
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
  status: text('status', {
    enum: ['uploaded', 'transcribed', 'queued', 'generating', 'generated', 'duplicate', 'failed'],
  }).notNull(),
  error: text('error'),
  generationJson: text('generation_json'),
  cardId: text('card_id'),
  createdAt: integer('created_at').notNull(),
  transcribedAt: integer('transcribed_at'),
  duplicateOf: text('duplicate_of'),
  topicId: text('topic_id'),
  glossRu: text('gloss_ru'),
  lang: text('lang', { enum: ['pl', 'ru'] }),
})

export const generationJobs = sqliteTable('generation_jobs', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['new', 'regenerate', 'suggest'] }).notNull(),
  captureId: text('capture_id'),
  cardId: text('card_id'),
  status: text('status', { enum: ['queued', 'running', 'done', 'failed'] }).notNull(),
  attempts: integer('attempts').notNull(),
  // Counts only non-retryable failures (spec §6); see migrations/002-generation-queue.sql.
  failures: integer('failures').notNull(),
  nextAttemptAt: integer('next_attempt_at').notNull(),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull(),
  finishedAt: integer('finished_at'),
  topicId: text('topic_id'),
  paramsJson: text('params_json'),
})

export const ttsClips = sqliteTable('tts_clips', {
  id: text('id').primaryKey(),
  mediaId: text('media_id').notNull(),
  lang: text('lang', { enum: ['pl', 'ru'] }).notNull(),
  voice: text('voice').notNull(),
  text: text('text').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const topics = sqliteTable('topics', {
  id: text('id').primaryKey(),
  name: text('name'),
  context: text('context').notNull(),
  suspendedAt: integer('suspended_at'),
  createdAt: integer('created_at').notNull(),
})

export const suggestions = sqliteTable('suggestions', {
  id: text('id').primaryKey(),
  topicId: text('topic_id').notNull(),
  round: integer('round').notNull(),
  answerPl: text('answer_pl').notNull(),
  glossRu: text('gloss_ru').notNull(),
  kind: text('kind', { enum: SUGGESTION_KINDS }).notNull(),
  status: text('status', { enum: ['proposed', 'accepted', 'rejected'] }).notNull(),
  captureId: text('capture_id'),
  createdAt: integer('created_at').notNull(),
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
