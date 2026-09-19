export type Lang = 'pl' | 'ru'

// Chirp 3: HD, GA for both locales in the `eu` region. Names confirmed by
// Step 1's probe of voices.list — do not invent them. Both are the "Kore"
// character, which exists for both locales, so the same voice persona speaks
// both languages.
export const VOICES: Record<Lang, string> = {
  pl: 'pl-PL-Chirp3-HD-Kore',
  ru: 'ru-RU-Chirp3-HD-Kore',
}
