'use client'

import { useEffect, useRef, useState } from 'react'
import { INTENT_DWELL_MS } from '@/hooks/useIntentWarm'

// Next's own hover-prefetch pattern: off until the person shows intent, then back
// to the default. The pointer must REST (INTENT_DWELL_MS), so crossing a list on
// the way elsewhere warms nothing; focus and touch are deliberate. Local state
// rather than useIntentWarm: ordersFinanceUsability.test.tsx renders links that use
// this outside the app router, where useRouter would throw.
//
// Spread it on a next/link <Link> (or use IntentLink): a Link left to Next's
// default prefetches every page it points to as soon as it is on screen, and each
// page brings a stylesheet the current page never applies, which Chrome logs as
// "preloaded but not used" (measured 2026-11-11 and 2026-11-12).
export function useWarmOnRest() {
  const [warm, setWarm] = useState(false)
  const rest = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(rest.current), [])
  return {
    prefetch: warm ? null : false,
    onPointerEnter: () => { clearTimeout(rest.current); rest.current = setTimeout(() => setWarm(true), INTENT_DWELL_MS) },
    onPointerLeave: () => clearTimeout(rest.current),
    onFocus: () => setWarm(true),
    onTouchStart: () => setWarm(true),
  }
}
