'use client'

import { useEffect } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { mergeSearchParams } from '@/lib/navigation/urlMirror'

/**
 * Keep a page's own list state visible in its URL, with `replace`.
 *
 * For a screen whose state already lives in React and is pinned there by its
 * own tests (the Finance lists), this is the smallest way to get what URL state
 * buys — Back from a record returns to the same tab, filters and page, and the
 * view can be bookmarked — without re-plumbing every control. The page reads its
 * initial values from the URL once (parseListState) and this mirrors every later
 * change back.
 *
 * ONLY THE KEYS IN `patch` ARE TOUCHED. Anything else in the query — a deep
 * link's `?payment=`, `?view=` — is left exactly as it is. A null value removes
 * its key, so a default filter keeps the address clean.
 *
 * `replace`, never `push`: narrowing a list is not a place to go Back to.
 * `delayMs` coalesces typing, so a search box does not rewrite the address on
 * every keystroke.
 *
 * Requires a <Suspense> boundary above it (it reads useSearchParams).
 */
export function useMirrorToUrl(
  patch: Record<string, string | null>,
  enabled: boolean,
  delayMs = 250,
): void {
  const router = useRouter()
  const pathname = usePathname()
  const current = useSearchParams().toString()
  const key = JSON.stringify(patch)

  useEffect(() => {
    if (!enabled) return
    const next = mergeSearchParams(current, JSON.parse(key) as Record<string, string | null>)
    if (next === current) return
    const timer = setTimeout(() => {
      router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false })
    }, delayMs)
    return () => clearTimeout(timer)
  }, [enabled, key, current, pathname, router, delayMs])
}
