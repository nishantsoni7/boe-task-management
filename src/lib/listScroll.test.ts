/**
 * List scroll position storage.
 *
 * The rules that matter here are the defensive ones: a key that cannot collide
 * across filter sets, and a read that returns "no position" rather than
 * throwing or scrolling somewhere absurd when storage holds something
 * unexpected — or when storage is unavailable at all.
 *
 * Run:
 *   npx tsx --test src/lib/listScroll.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  SCROLL_KEY_PREFIX, scrollStorageKey, readScrollTop, writeScrollTop,
  nextRestoreStep, createHistoryReturnTracker,
  type ScrollStore,
} from './listScroll'

function fakeStore(initial: Record<string, string> = {}): ScrollStore & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = value },
    removeItem: key => { delete data[key] },
  }
}

const throwingStore: ScrollStore = {
  getItem() { throw new Error('storage disabled') },
  setItem() { throw new Error('storage disabled') },
  removeItem() { throw new Error('storage disabled') },
}

describe('scrollStorageKey', () => {
  test('keys on pathname plus the complete query string', () => {
    assert.equal(
      scrollStorageKey('/tasks/assigned-by-me', 'tab=in_progress&page=2'),
      `${SCROLL_KEY_PREFIX}/tasks/assigned-by-me?tab=in_progress&page=2`,
    )
  })

  test('two filter sets on one page are two different lists', () => {
    assert.notEqual(
      scrollStorageKey('/tasks/my', 'tab=overdue'),
      scrollStorageKey('/tasks/my', 'tab=all'),
    )
  })

  test('a leading ? is accepted and not doubled', () => {
    assert.equal(
      scrollStorageKey('/tasks/my', '?tab=all'),
      scrollStorageKey('/tasks/my', 'tab=all'),
    )
  })

  test('an unfiltered list has no query suffix', () => {
    assert.equal(scrollStorageKey('/tasks/my', ''), `${SCROLL_KEY_PREFIX}/tasks/my`)
  })
})

describe('readScrollTop / writeScrollTop', () => {
  const key = scrollStorageKey('/tasks/my', 'tab=all')

  test('round-trips an offset', () => {
    const store = fakeStore()
    writeScrollTop(store, key, 840)
    assert.equal(readScrollTop(store, key), 840)
  })

  test('a fractional offset is stored as a whole pixel', () => {
    const store = fakeStore()
    writeScrollTop(store, key, 840.6)
    assert.equal(readScrollTop(store, key), 840)
  })

  test('the top of the list is stored as no position at all', () => {
    const store = fakeStore({ [key]: '500' })
    writeScrollTop(store, key, 0)
    assert.equal(readScrollTop(store, key), null)
  })

  test('nothing stored means nothing to restore', () => {
    assert.equal(readScrollTop(fakeStore(), key), null)
  })

  test('a corrupt or nonsensical stored value is ignored', () => {
    assert.equal(readScrollTop(fakeStore({ [key]: 'top' }), key), null)
    assert.equal(readScrollTop(fakeStore({ [key]: '-40' }), key), null)
    assert.equal(readScrollTop(fakeStore({ [key]: '' }), key), null)
    assert.equal(readScrollTop(fakeStore({ [key]: 'Infinity' }), key), null)
  })

  test('unavailable storage never throws', () => {
    assert.equal(readScrollTop(throwingStore, key), null)
    assert.doesNotThrow(() => writeScrollTop(throwingStore, key, 300))
    assert.equal(readScrollTop(null, key), null)
    assert.doesNotThrow(() => writeScrollTop(null, key, 300))
  })
})

describe('nextRestoreStep', () => {
  const deadline = 1000

  test('scrolls as soon as the list is tall enough', () => {
    assert.deepEqual(
      nextRestoreStep({ target: 800, maxTop: 800, now: 0, deadline }),
      { action: 'scroll', top: 800 },
    )
  })

  test('waits while the list is still shorter than the saved offset', () => {
    assert.deepEqual(
      nextRestoreStep({ target: 800, maxTop: 120, now: 500, deadline }),
      { action: 'wait' },
    )
  })

  test('the loop is bounded: past the deadline it never asks to wait again', () => {
    for (const maxTop of [0, 1, 120, 799]) {
      for (const now of [deadline, deadline + 1, deadline + 100_000]) {
        const step = nextRestoreStep({ target: 800, maxTop, now, deadline })
        assert.notEqual(step.action, 'wait', `maxTop=${maxTop} now=${now}`)
      }
    }
  })

  test('a list that came back shorter settles at its new bottom', () => {
    assert.deepEqual(
      nextRestoreStep({ target: 800, maxTop: 300, now: deadline, deadline }),
      { action: 'scroll', top: 300 },
    )
  })

  test('a list with nothing to scroll gives up rather than scrolling to 0', () => {
    assert.deepEqual(
      nextRestoreStep({ target: 800, maxTop: 0, now: deadline, deadline }),
      { action: 'give-up' },
    )
  })
})

describe('createHistoryReturnTracker', () => {
  const WINDOW = 2000
  const KEY   = scrollStorageKey('/tasks/my', 'tab=overdue')
  const OTHER = scrollStorageKey('/tasks/assigned-by-me', '')

  test('a fresh load is not a history return — nothing to restore on refresh or a typed URL', () => {
    const tracker = createHistoryReturnTracker(WINDOW)
    assert.equal(tracker.claim(KEY, 1000), false)
  })

  test('a mount right after Back is a history return', () => {
    const tracker = createHistoryReturnTracker(WINDOW)
    tracker.noteHistoryNavigation(1000)
    assert.equal(tracker.claim(KEY, 1005), true)
  })

  test('the same key can claim twice — StrictMode double-invokes the effect', () => {
    const tracker = createHistoryReturnTracker(WINDOW)
    tracker.noteHistoryNavigation(1000)
    assert.equal(tracker.claim(KEY, 1005), true)
    assert.equal(tracker.claim(KEY, 1006), true)
  })

  test('one history navigation restores one list, not the next one opened after it', () => {
    const tracker = createHistoryReturnTracker(WINDOW)
    tracker.noteHistoryNavigation(1000)
    assert.equal(tracker.claim(KEY, 1005), true)
    // A menu click moments later opens a different list — a fresh navigation.
    assert.equal(tracker.claim(OTHER, 1200), false)
  })

  test('a list opened long after the last Back is not a return', () => {
    const tracker = createHistoryReturnTracker(WINDOW)
    tracker.noteHistoryNavigation(1000)
    assert.equal(tracker.claim(KEY, 1000 + WINDOW + 1), false)
  })

  test('the next Back re-arms the tracker for whichever list it lands on', () => {
    const tracker = createHistoryReturnTracker(WINDOW)
    tracker.noteHistoryNavigation(1000)
    assert.equal(tracker.claim(KEY, 1005), true)
    tracker.noteHistoryNavigation(5000)
    assert.equal(tracker.claim(OTHER, 5005), true)
  })
})
