// One owner for locking page scroll while something is covering the page.
//
// THE BUG THIS EXISTS TO PREVENT
// ------------------------------
// The obvious way to lock scrolling is for each overlay to remember what
// `body.style.overflow` was, set it to 'hidden', and put the old value back on
// unmount. That is correct for ONE overlay and quietly wrong for two.
//
// On Payroll Result Detail the settlement dialog locks scroll while it is open,
// and the saving overlay locks it again on top. Each captured a "previous"
// value independently:
//
//   page             body.overflow = ''
//   dialog opens     remembers '',        sets 'hidden'
//   Save clicked     remembers 'hidden',  sets 'hidden'   ← already locked
//   save succeeds    dialog and overlay unmount in the SAME React commit
//   dialog cleanup   restores ''                          → scrollable
//   overlay cleanup  restores 'hidden'                    → LOCKED, and stays
//
// The overlay's cleanup ran last and faithfully restored the value it had
// observed, which was the dialog's lock rather than the page's real state. The
// page was left unscrollable with nothing on screen to explain why. Reversing
// the order would only move the bug to whichever component happened to unmount
// second.
//
// THE FIX
// -------
// A single reference count in this module, not a value per component. The real
// pre-lock overflow is captured once, when the count goes from zero to one, and
// restored once, when it returns to zero. Overlapping locks in any order, and
// any unmount order, all end at the value the page started with.
//
// The count is module state on purpose: two components that never meet in the
// tree still have to agree, and there is nothing to render, so a context
// provider would be ceremony around a number.

import { useEffect } from 'react'

let lockCount = 0
/** The page's genuine overflow, captured only on the outermost lock. */
let restoreValue: string | null = null

/**
 * Lock page scroll until the returned function is called.
 *
 * Imperative rather than hook-only so the lifecycle can be tested without a DOM
 * renderer: the sequences that matter here are about ORDER, and driving them
 * directly is a truer test than one that depends on how React batches.
 */
export function acquireScrollLock(): () => void {
  if (typeof document === 'undefined') return () => {}

  if (lockCount === 0) {
    restoreValue = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  lockCount += 1

  let released = false
  return () => {
    // Guarded so a double release — a cleanup that runs twice, a caller that
    // holds a stale handle — cannot drop the count below the locks that are
    // genuinely still held and unlock the page underneath them.
    if (released) return
    released = true

    lockCount -= 1
    if (lockCount === 0) {
      // Assigning the captured value, never a hard-coded 'auto': the page may
      // legitimately have had an overflow of its own, and '' correctly means
      // "no inline style" rather than "scrolling forced on".
      document.body.style.overflow = restoreValue ?? ''
      restoreValue = null
    }
  }
}

/** Hold a scroll lock for as long as `active` is true and the caller is mounted. */
export function useScrollLock(active: boolean = true) {
  useEffect(() => {
    if (!active) return
    return acquireScrollLock()
  }, [active])
}

/** Test seam: the internal state, and a way to clear it between cases. */
export function __scrollLockState() {
  return { lockCount, restoreValue }
}
export function __resetScrollLock() {
  lockCount = 0
  restoreValue = null
}
