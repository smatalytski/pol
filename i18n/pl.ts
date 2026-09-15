export const t = {
  appName: 'Fiszki',

  review: 'Powtórki',
  add: 'Dodaj',
  images: 'Obrazki',
  cards: 'Fiszki',
  settings: 'Ustawienia',

  show: 'pokaż',
  again: 'nie pamiętam',
  hard: 'z trudem',
  good: 'dobrze',
  easy: 'łatwo',
  undo: 'cofnij',

  doneForToday: 'Na dziś koniec',
  nextDue: 'Następna powtórka',
  noCards: 'Brak fiszek',
  sessionReviewed: 'Przejrzano',
  nextReviewAt: 'Kolejna powtórka',

  holdToRecord: 'przytrzymaj i mów',
  uploading: 'wysyłanie…',
  transcribing: 'rozpoznawanie…',
  alreadyHave: 'już masz',
  retry: 'ponów',
  deleteItem: 'usuń',
  play: 'odtwórz',
  micDenied: 'Bez dostępu do mikrofonu nie da się nic dodać. Włącz mikrofon w ustawieniach przeglądarki i odśwież stronę.',

  dropImages: 'przeciągnij obrazki tutaj',
  imagePrompt: 'obrazek',
  addForms: 'dodaj formy',
  suspend: 'zawieś',
  unsuspend: 'przywróć',
  save: 'zapisz',
  needsInput: 'do uzupełnienia',

  newPerDay: 'Nowe fiszki na dzień',
  targetRetention: 'Docelowa skuteczność',

  logIn: 'wejdź',
  badPassword: 'złe hasło',
  passwordPlaceholder: 'hasło',
} as const

export type Strings = typeof t
