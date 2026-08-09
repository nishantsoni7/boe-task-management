/**
 * Scroll-lock lifecycle on Payroll Result Detail.
 *
 * The regression these cover: after saving a previous balance the page could
 * not be scrolled. The settlement dialog and the saving overlay each remembered
 * `body.style.overflow` for themselves, so the overlay — which mounts on top of
 * an already-locked page — captured 'hidden' as the page's "real" value and
 * restored it after both had gone.
 *
 * What is being asserted is ORDER, so the lock is driven directly rather than
 * through a renderer. Each test below is a sequence React actually produces:
 * both cleanups in one commit, cleanup while the dialog stays open, a
 * Strict-Mode double invoke, an unmount mid-save.
 *
 * Run:
 *   npx tsx --test src/hooks/useScrollLock.test.ts
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { acquireScrollLock, __scrollLockState, __resetScrollLock } from '@/hooks/useScrollLock'

// A stand-in for the one property the lock touches. A plain import is enough
// because the module reads `document` inside acquireScrollLock rather than at
// module scope, so this only has to be in place before the first call.
const body = { style: { overflow: '' } }
;(globalThis as unknown as { document: unknown }).document = { body }

const overflow = () => body.style.overflow

beforeEach(() => {
  __resetScrollLock()
  body.style.overflow = ''
})

describe('a single owner locks and restores', () => {
  test('the page starts unlocked, locks, and comes back to where it was', () => {
    assert.equal(overflow(), '')
    const release = acquireScrollLock()
    assert.equal(overflow(), 'hidden')
    release()
    assert.equal(overflow(), '')
  })

  test('an overflow the page genuinely had is preserved, not replaced with auto', () => {
    // The application may have set this itself. Forcing 'auto' on release would
    // silently overwrite it.
    body.style.overflow = 'clip'
    const release = acquireScrollLock()
    assert.equal(overflow(), 'hidden')
    release()
    assert.equal(overflow(), 'clip')
  })
})

describe('the dialog and the saving overlay together', () => {
  test('THE REGRESSION: both released in one commit leaves the page scrollable', () => {
    // 1. modal open
    const dialog = acquireScrollLock()
    assert.equal(overflow(), 'hidden', 'the dialog locks the page')

    // 2. save begins — the overlay locks a page that is already locked
    const overlay = acquireScrollLock()
    assert.equal(overflow(), 'hidden')

    // 3. modal closes and the overlay ends in the SAME React update. React
    //    runs sibling cleanups in tree order, so the dialog goes first and the
    //    overlay last — the order that used to lose.
    dialog()
    assert.equal(overflow(), 'hidden', 'still locked: the overlay is up')
    overlay()

    // 4. back to the original value
    assert.equal(overflow(), '', 'the page must be scrollable again')
    assert.equal(__scrollLockState().lockCount, 0)
  })

  test('the opposite release order ends in the same place', () => {
    const dialog  = acquireScrollLock()
    const overlay = acquireScrollLock()
    overlay()
    assert.equal(overflow(), 'hidden', 'the dialog is still open')
    dialog()
    assert.equal(overflow(), '')
  })

  test('5a. a FAILED save: the overlay goes, the dialog stays and keeps the lock', () => {
    const dialog  = acquireScrollLock()
    const overlay = acquireScrollLock()

    overlay()   // overlay removed, modal left open with its values
    assert.equal(overflow(), 'hidden', 'the dialog is still covering the page')

    dialog()    // admin cancels or retries successfully
    assert.equal(overflow(), '', 'scrolling returns once the dialog goes')
  })

  test('5b. unmount mid-save — navigating away — leaves nothing behind', () => {
    const dialog  = acquireScrollLock()
    const overlay = acquireScrollLock()

    // Route change: React unmounts the whole page, both cleanups run.
    overlay()
    dialog()

    assert.equal(overflow(), '', 'no body style may survive the page')
    assert.equal(__scrollLockState().lockCount, 0)
    assert.equal(__scrollLockState().restoreValue, null)
  })
})

describe('repeated use does not accumulate', () => {
  test('save, save, save — the count returns to zero every time', () => {
    for (let i = 0; i < 3; i++) {
      const dialog  = acquireScrollLock()
      const overlay = acquireScrollLock()
      dialog()
      overlay()
      assert.equal(overflow(), '', `run ${i + 1} must end unlocked`)
      assert.equal(__scrollLockState().lockCount, 0, `run ${i + 1} must not leak a lock`)
    }
  })

  test('a cleanup that runs twice cannot unlock the page under a live lock', () => {
    // React Strict Mode, a stale handle, a double-invoked effect cleanup.
    const dialog  = acquireScrollLock()
    const overlay = acquireScrollLock()

    overlay()
    overlay()   // second release of the same handle — must be inert

    assert.equal(overflow(), 'hidden', 'the dialog still holds a lock')
    assert.equal(__scrollLockState().lockCount, 1)

    dialog()
    assert.equal(overflow(), '')
  })

  test('Strict Mode mount → unmount → mount captures the real value both times', () => {
    const first = acquireScrollLock()
    first()                                  // the discarded first invocation
    assert.equal(overflow(), '')

    const second = acquireScrollLock()       // the real one
    assert.equal(overflow(), 'hidden')
    second()
    assert.equal(overflow(), '', 'not left holding a value captured while locked')
  })
})
