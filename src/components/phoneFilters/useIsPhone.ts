'use client'

import { useSyncExternalStore } from 'react'

/**
 * True below 768px, the phone breakpoint every `@media (max-width: 767px)` rule
 * uses. For the few drawings CSS cannot fix (an SVG chart's viewBox sets how
 * big its text comes out). The server, and the first paint, say false, so a
 * desktop draws exactly what it drew before.
 */
const PHONE_QUERY = '(max-width: 767px)'

function subscribe(onChange: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mq = window.matchMedia(PHONE_QUERY)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

export function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(PHONE_QUERY).matches,
    () => false,
  )
}
