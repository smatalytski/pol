// Punctuation only. Never strip diacritics: ł/l, s/ś, z/ż are distinct letters,
// and folding them would merge unrelated Polish words into one card.
const PUNCT = /[.,!?;:"'`´()[\]{}…—–\-«»„""'']/g

export function answerKey(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(PUNCT, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
