// Configuration, not secrets. Authentication is Application Default
// Credentials throughout — there is no API key anywhere in this app.
import { requireEnv } from '../env'

export function gcpProject(): string {
  return requireEnv('GOOGLE_CLOUD_PROJECT')
}

/** Speech-to-Text and Text-to-Speech. Polish requires `eu`. */
export function speechLocation(): string {
  return process.env.GCP_SPEECH_LOCATION ?? 'eu'
}

/** Gemini on Vertex. `global` is Google's recommended default. */
export function vertexLocation(): string {
  return process.env.GCP_VERTEX_LOCATION ?? 'global'
}
