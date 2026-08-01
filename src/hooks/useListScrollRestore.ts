'use client'

import { useEffect, useRef } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  createHistoryReturnTracker, nextRestoreStep, readScrollTop, scrollStorageKey, writeScrollTop,
  type ScrollStore,
} from '@/lib/listScroll'

// How long after a popstate a mount still counts as "the user pressed Back".
// A history traversal re-renders the route in the same tick; this only has to
// outlast that.
const HISTORY_RETURN_WINDOW_MS = 2000

// Hard ceiling on the retry loop. These pages show a loading screen first, so
// the document is short at mount and only reaches full height once the first
// query resolves — but if it never does, the loop stops here regardless.
const RESTORE_DEADLINE_MS = 2500

// Unambiguous user input. A deliberate scroll, tap or keypress outranks a
// pending restore, so the page never yanks itself out from under the user.
// `scroll` is deliberately not in this list: it also fires for our own
// `scrollTo` and for layout changes, so it cannot tell intent apart.
const CANCEL_EVENTS = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const

// Module-scoped because the list page is unmounted while the user is on the
// task detail — it cannot hear its own popstate. The listener is installed once
// when the first list page loads and survives for the SPA session. A reload or a
// typed URL starts a fresh module with nothing recorded, so neither can look
// like a history return.
const historyReturn = createHistoryReturnTracker(HISTORY_RETURN_WINDOW_MS)
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => historyReturn.noteHistoryNavigation(Date.now()))
}

function sessionStore(): ScrollStore | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

/**
 * Remember where the user was in a list, and put them back there when they
 * return through history.
 *
 * Restoring is deliberately narrow — it happens only when all of these hold:
 *   * the mount follows a popstate (Back/Forward), not a reload, a typed URL or
 *     an in-app navigation,
 *   * the pathname *and* full query string match the view that was left,
 *   * a non-zero offset was stored for it, and
 *   * the user has not touched the page since arriving.
 *
 * A filter change re-renders this component rather than remounting it, so it
 * never triggers a restore.
 *
 * Requires a `<Suspense>` boundary above it — it reads `useSearchParams`.
 */
export function useListScrollRestore(): void {
  const pathname = usePathname()
  const search   = useSearchParams().toString()
  const key      = scrollStorageKey(pathname, search)

  // Sampled from a passive scroll listener rather than read at unmount: by the
  // time a client-side navigation tears this component down, the window may
  // already have been scrolled to the top of the next route.
  const scrollTopRef = useRef(0)

  useEffect(() => {
    scrollTopRef.current = window.scrollY
    const onScroll = () => { scrollTopRef.current = window.scrollY }
    const save = () => writeScrollTop(sessionStore(), key, scrollTopRef.current)

    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('pagehide', save)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('pagehide', save)
      // Runs on unmount and whenever the filters change the key — each list
      // view keeps its own offset, saved under the key it was scrolled in.
      save()
    }
  }, [key])

  useEffect(() => {
    if (!historyReturn.claim(key, Date.now())) return
    const target = readScrollTop(sessionStore(), key)
    if (target === null || target === 0) return

    let frame = 0
    let stopped = false

    const stop = () => {
      if (stopped) return
      stopped = true
      if (frame !== 0) { cancelAnimationFrame(frame); frame = 0 }
      for (const type of CANCEL_EVENTS) window.removeEventListener(type, stop)
    }

    const deadline = Date.now() + RESTORE_DEADLINE_MS
    const attempt = () => {
      frame = 0
      if (stopped) return
      const step = nextRestoreStep({
        target,
        maxTop: document.documentElement.scrollHeight - window.innerHeight,
        now: Date.now(),
        deadline,
      })
      if (step.action === 'wait') { frame = requestAnimationFrame(attempt); return }
      if (step.action === 'scroll') window.scrollTo(0, step.top)
      stop()
    }

    for (const type of CANCEL_EVENTS) window.addEventListener(type, stop, { passive: true })
    frame = requestAnimationFrame(attempt)
    return stop
    // Mount only: `key` is captured as it was on arrival. A later filter change
    // is the user's own action and must not scroll the page.
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}
