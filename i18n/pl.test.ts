import { describe, expect, it } from 'vitest'
import { t } from './pl'

describe('strings', () => {
  it('defines every key the screens use', () => {
    const required = [
      'appName', 'review', 'add', 'cards', 'settings',
      'show', 'again', 'hard', 'good', 'easy', 'undo',
      'doneForToday', 'noCards', 'sessionReviewed', 'nextReviewAt', 'rateFailed',
      'holdToRecord', 'recordPolish', 'recordRussian', 'uploading', 'transcribing', 'alreadyHave', 'retry', 'deleteItem', 'play', 'micDenied',
      'suspend', 'unsuspend', 'needsInput', 'queued', 'generating',
      'saveFailed',
      'newPerDay', 'targetRetention', 'settingsSaveFailed', 'logIn', 'badPassword', 'passwordPlaceholder',
      'topics', 'newTopic', 'propose', 'searching', 'more', 'tryAgain',
      'topicsLoadFailed', 'topicSaveFailed',
      'levelAdvanced', 'levelIntermediate', 'levelBadge', 'tabCarded', 'tabOpen', 'tabDiscarded',
      'makeCard', 'discard', 'restore', 'cardBadge', 'moveTo', 'manualAdd', 'manualPlaceholder',
      'addItem', 'cancel', 'moveToDiscarded',
      'listen', 'listenLength', 'listenStart', 'listenStop', 'listenPause', 'listenResume',
      'listenSkip', 'listenDone', 'listenCards', 'listenAgain', 'listenFailed', 'listenMinutesLeft',
      'approveNow', 'approveFailed', 'settingsGeneral', 'filterTopics', 'addTopic', 'removeTopic',
      'listenTopicsAll', 'sheetClose', 'noTopicsFound', 'allTopicsChosen',
      'listenSection', 'listenGap', 'listenNext', 'listenRepeat', 'listenExample', 'listenHint', 'listenRepeatExample',
      'listenSummaryGap', 'listenSummaryNext', 'listenSummaryRepeat', 'listenSummaryExample', 'listenSummaryHint', 'listenSummaryExampleTwice',
    ]
    for (const key of required) expect(t).toHaveProperty(key)
  })

  it('contains no English and no Russian in the chrome', () => {
    // Chrome is Polish. Russian belongs only in card content, never in labels.
    for (const [key, value] of Object.entries(t)) {
      expect(value, key).not.toMatch(/[Ѐ-ӿ]/)
      expect(value, key).not.toMatch(/\b(show|again|hard|good|easy|settings|cards)\b/i)
    }
  })

  it('has no empty strings', () => {
    for (const [key, value] of Object.entries(t)) expect(value.trim(), key).not.toBe('')
  })

  it('pins the four ratings to their exact values and order', () => {
    // FSRS Again/Hard/Good/Easy, in that order. A swap here means a button
    // reading "dobrze" silently records Hard — the schedule corrupts with
    // no way for the user to notice.
    expect([t.again, t.hard, t.good, t.easy]).toEqual(['nie pamiętam', 'z trudem', 'dobrze', 'łatwo'])
  })
})
