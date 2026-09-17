import { v2 } from '@google-cloud/speech'
import { gcpProject, speechLocation } from '../gcp/clients'

export interface Transcriber {
  transcribe(input: { bytes: Uint8Array; mime: string }): Promise<string>
}

export class TranscriptionError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'TranscriptionError'
  }
}

type RecognizeResponse = {
  results?: Array<{ alternatives?: Array<{ transcript?: string | null }> | null }> | null
}
export type RecognizeFn = (req: unknown) => Promise<[RecognizeResponse, ...unknown[]]>

export function speechTranscriber(opts: {
  project: string
  location?: string
  model?: string
  recognize: RecognizeFn
}): Transcriber {
  const location = opts.location ?? 'eu'
  const model = opts.model ?? 'chirp_3'

  return {
    async transcribe({ bytes }) {
      let res: RecognizeResponse
      try {
        ;[res] = await opts.recognize({
          recognizer: `projects/${opts.project}/locations/${location}/recognizers/_`,
          config: {
            // Let the service sniff the container. The browser gives us
            // webm/opus, but MediaRecorder's exact output varies by device and
            // hard-coding an encoding would break on some phones.
            autoDecodingConfig: {},
            model,
            // Dictation is always Polish. Auto-detection guesses wrong on
            // single words and silently yields Russian or English spellings.
            languageCodes: ['pl-PL'],
            features: { enableAutomaticPunctuation: true },
          },
          content: bytes,
        })
      } catch (err) {
        const status = (err as { code?: number }).code
        throw new TranscriptionError(`transcription failed: ${(err as Error).message}`, status)
      }

      const results = res.results ?? []
      if (results.length === 0) throw new TranscriptionError('transcription returned no results')

      // Join every result: a long utterance comes back segmented, and keeping
      // only the first would truncate it without any visible error.
      const text = results
        .map((r) => r.alternatives?.[0]?.transcript ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()

      if (!text) throw new TranscriptionError('transcription returned no text')
      return text
    },
  }
}

export function getTranscriber(): Transcriber {
  const location = speechLocation()
  const client = new v2.SpeechClient({ apiEndpoint: `${location}-speech.googleapis.com` })
  return speechTranscriber({
    project: gcpProject(),
    location,
    recognize: (req) => client.recognize(req as never) as never,
  })
}
