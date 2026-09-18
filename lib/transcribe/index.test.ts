import { describe, expect, it, vi } from 'vitest'
import { TranscriptionError, speechTranscriber } from './index'

const audio = { bytes: new Uint8Array([1, 2, 3]), mime: 'audio/webm' }

const ok = (...transcripts: string[]) =>
  vi.fn().mockResolvedValue([
    { results: transcripts.map((t) => ({ alternatives: [{ transcript: t }] })) },
  ])

const make = (recognize: ReturnType<typeof ok>) =>
  speechTranscriber({ project: 'proj', recognize: recognize as never })

describe('speechTranscriber', () => {
  it('returns the trimmed transcript', async () => {
    expect(await make(ok('  złośliwy  ')).transcribe(audio)).toBe('złośliwy')
  })

  it('pins the language to Polish and never auto-detects', async () => {
    const recognize = ok('x')
    await make(recognize).transcribe(audio)
    const req = recognize.mock.calls[0][0] as {
      config: { languageCodes: string[]; model: string }
    }
    expect(req.config.languageCodes).toEqual(['pl-PL'])
    expect(req.config.model).toMatch(/^chirp/)
  })

  // Measured, not assumed: with ['pl-PL','ru-RU'] the Polish model swallows
  // Russian whole — spoken "\u0441\u043a\u043b\u0435\u043f" came back "sklep", "\u0447\u0430\u0441" came back "czas",
  // and "\u0431\u0435\u0448\u0435\u043d\u0441\u0442\u0432\u043e" came back "wskieklo\u015b\u0107", in both code orders. A single
  // code was correct on every word in both languages. So the language is
  // always exactly one code, chosen by the caller, never a list to detect
  // between.
  it('asks for Russian when told the recording is Russian', async () => {
    const recognize = ok('\u0441\u043a\u043b\u0435\u043f')
    await make(recognize).transcribe({ ...audio, lang: 'ru' })
    const req = recognize.mock.calls[0][0] as { config: { languageCodes: string[] } }
    expect(req.config.languageCodes).toEqual(['ru-RU'])
  })

  it('never sends more than one language code, whichever language is asked for', async () => {
    for (const lang of ['pl', 'ru'] as const) {
      const recognize = ok('x')
      await make(recognize).transcribe({ ...audio, lang })
      const req = recognize.mock.calls[0][0] as { config: { languageCodes: string[] } }
      expect(req.config.languageCodes).toHaveLength(1)
    }
  })

  it('targets a regional recognizer, because Polish is only served from eu', async () => {
    const recognize = ok('x')
    await make(recognize).transcribe(audio)
    const req = recognize.mock.calls[0][0] as { recognizer: string }
    expect(req.recognizer).toBe('projects/proj/locations/eu/recognizers/_')
  })

  it('joins multiple results rather than keeping only the first', async () => {
    expect(await make(ok('na wszelki', 'wypadek')).transcribe(audio)).toBe('na wszelki wypadek')
  })

  it('wraps an API failure in a TranscriptionError carrying the status', async () => {
    const recognize = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 7 }))
    const t = speechTranscriber({ project: 'proj', recognize: recognize as never })
    await expect(t.transcribe(audio)).rejects.toThrow(TranscriptionError)
    await expect(t.transcribe(audio)).rejects.toMatchObject({ status: 7 })
  })

  it('throws when no results come back', async () => {
    const recognize = vi.fn().mockResolvedValue([{ results: [] }])
    await expect(
      speechTranscriber({ project: 'proj', recognize: recognize as never }).transcribe(audio),
    ).rejects.toThrow(TranscriptionError)
  })

  it('throws when the transcript is empty, so an empty card is never created', async () => {
    await expect(make(ok('   ')).transcribe(audio)).rejects.toThrow(TranscriptionError)
  })
})
