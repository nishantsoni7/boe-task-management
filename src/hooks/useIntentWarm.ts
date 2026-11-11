'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

// How long a pointer must REST on something before the page behind it is warmed.
// A warmed page brings its stylesheet, and Chrome logs "preloaded but not used"
// for every one the person never opens. A pointer merely crossing is quicker
// than this; a pointer about to click is not.
export const INTENT_DWELL_MS = 250

/**
 * Warm a route on INTENT, never on load: `warmOnRest` from a pointer-enter
 * (cancelled by `cancel` on pointer-leave), `warmNow` from focus or touch-start,
 * which are deliberate. One pending timer: the pointer is on one thing at a time.
 */
export function useIntentWarm() {
  const router = useRouter()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const cancel = useCallback(() => clearTimeout(timer.current), [])
  useEffect(() => cancel, [cancel])

  const warmOnRest = useCallback((href: string) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => router.prefetch(href), INTENT_DWELL_MS)
  }, [router])

  const warmNow = useCallback((href: string) => router.prefetch(href), [router])

  return { warmOnRest, warmNow, cancel }
}
