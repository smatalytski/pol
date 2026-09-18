// Live provider smoke-check. Run this once against real Google Cloud APIs
// after every deploy (and after touching lib/generate, lib/tts or
// lib/transcribe) — see the README's "Post-deploy checklist".
//
// Why this exists: each provider module's real wiring (as opposed to its
// unit tests, which inject the SDK call and never touch the network) was
// verified exactly once, by hand, with a throwaway probe script that was
// then deleted. All three provider tasks shipped a defect that only showed
// up in that unreachable path — Task 8 imported the Speech v1 client while
// believing it was v2, and Tasks 9 and 11 both used `require()` in an ESM
// project. A unit test that mocks the SDK call structurally cannot catch
// either kind of mistake: the wrong import still satisfies the mock. This
// script makes one real call per service through the actual production
// entry points (getTranscriber, getGenerator, getSynthesizer) and checks
// something about the response beyond "it didn't throw."
//
// It cannot be run inside the sandbox this was written in — that sandbox has
// no egress to Google's APIs (see the task report). It has not been run
// against real credentials by its author. Run it for the first time on the
// VM, or locally with `gcloud auth application-default login` already done,
// and treat any failure as a real finding.
//
// Usage:
//   npm run check-providers
// Requires GOOGLE_CLOUD_PROJECT and FISZKI_MODEL in the environment (or in
// .env.local, which this script loads itself — Next.js loads .env.local for
// the app, but a standalone script like this one is not Next.js). ADC must
// already be set up: `gcloud auth application-default login` locally, or the
// VM's attached service account in production.

import { existsSync, readFileSync } from 'node:fs'
import { getTranscriber } from '../lib/transcribe/index'
import { getGenerator } from '../lib/generate/index'
import { getSynthesizer, VOICES } from '../lib/tts/index'

// Next.js loads .env.local automatically; a bare `node`/`tsx` process does
// not. Load it here, but never override a variable the caller already
// exported — an explicit `export FOO=bar` before running this script should
// win over whatever is on disk.
function loadEnvLocal(): void {
  const path = '.env.local'
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function stripDiacritics(s: string): string {
  return s
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

const CYRILLIC = /[а-яё]/i
const POLISH_LATIN = /[a-ząćęłńóśźż]/i

type Result = { name: string; ok: boolean; detail: string }

async function checkTts(): Promise<{ result: Result; bytes?: Uint8Array }> {
  const name = 'Cloud TTS'
  try {
    const synth = getSynthesizer()
    const { bytes, mime, voice } = await synth.synthesize('Cześć, jak się masz?', 'pl')
    if (mime !== 'audio/mpeg') throw new Error(`unexpected mime: ${mime}`)
    if (voice !== VOICES.pl) throw new Error(`unexpected voice: ${voice}`)
    // A silent or empty clip would still satisfy "no exception" — a couple
    // of seconds of MP3 speech is reliably more than a couple of KB.
    if (bytes.byteLength < 2000) throw new Error(`suspiciously small audio: ${bytes.byteLength} bytes`)
    return {
      result: { name, ok: true, detail: `${bytes.byteLength} bytes of ${mime}, voice ${voice}` },
      bytes,
    }
  } catch (err) {
    return { result: { name, ok: false, detail: (err as Error).message } }
  }
}

async function checkSpeech(ttsBytes: Uint8Array | undefined): Promise<Result> {
  const name = 'Speech-to-Text v2'
  if (!ttsBytes) {
    return { name, ok: false, detail: 'skipped: no audio to transcribe (Cloud TTS check failed first)' }
  }
  try {
    const transcriber = getTranscriber()
    // Round-trip through Cloud TTS rather than shipping a checked-in audio
    // fixture: it needs no binary in the repo, and it exercises the same
    // "autoDecodingConfig sniffs the container" path the real capture
    // pipeline relies on, just with MP3 instead of the browser's webm/opus.
    const transcript = await transcriber.transcribe({ bytes: ttsBytes, mime: 'audio/mpeg' })
    const normalized = stripDiacritics(transcript)
    const expectedWords = ['czesc', 'jak', 'sie', 'masz']
    const hit = expectedWords.some((w) => normalized.includes(w))
    if (!hit) {
      throw new Error(`transcript did not contain any expected word: "${transcript}"`)
    }
    return { name, ok: true, detail: `transcribed: "${transcript}"` }
  } catch (err) {
    return { name, ok: false, detail: (err as Error).message }
  }
}

async function checkGemini(): Promise<Result> {
  const name = 'Gemini on Vertex'
  try {
    const generator = getGenerator()
    const card = await generator.fromDictation('kot')
    if (!card.answer_pl.trim()) throw new Error('answer_pl is empty')
    if (!card.prompt_ru.trim()) throw new Error('prompt_ru is empty')
    if (!CYRILLIC.test(card.prompt_ru)) throw new Error(`prompt_ru has no Cyrillic: "${card.prompt_ru}"`)
    if (!POLISH_LATIN.test(card.answer_pl)) throw new Error(`answer_pl has no Latin script: "${card.answer_pl}"`)
    // "kot" is an unambiguous noun: the kind and at least one basic form must
    // come back, or the forms schema is not reaching the model.
    if (card.kind !== 'rzeczownik') throw new Error(`kind for "kot" was "${card.kind}", not rzeczownik`)
    if (card.forms_basic.length === 0) throw new Error('forms_basic came back empty for "kot"')
    return {
      name,
      ok: true,
      detail: `prompt_ru="${card.prompt_ru}" answer_pl="${card.answer_pl}" kind=${card.kind} basic=${JSON.stringify(card.forms_basic)}`,
    }
  } catch (err) {
    return { name, ok: false, detail: (err as Error).message }
  }
}

async function main(): Promise<void> {
  loadEnvLocal()

  const results: Result[] = []

  const { result: ttsResult, bytes } = await checkTts()
  results.push(ttsResult)
  results.push(await checkSpeech(bytes))
  results.push(await checkGemini())

  console.log()
  for (const r of results) {
    console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.name} — ${r.detail}`)
  }
  console.log()

  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0) {
    console.error(`${failed.length}/${results.length} provider check(s) failed.`)
    process.exit(1)
  }
  console.log(`All ${results.length} provider checks passed.`)
}

main().catch((err) => {
  console.error('check-providers crashed:', err)
  process.exit(1)
})
