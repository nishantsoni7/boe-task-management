'use client'

import Link, { useLinkStatus } from 'next/link'
import { useEffect } from 'react'
import { beginNavWait, leavesThisPage } from '@/lib/navigation/navWait'

// Renders nothing. Inside a <Link>, it reports that link's wait to the page by
// marking <html> (src/lib/navigation/navWait.ts); globals.css turns the mark into
// the full-screen BOE One loader, after a pause (1.2 s) so a quick click never
// flashes it. Because pages load on click (see AppLink), a slow click is
// otherwise silent: nothing on screen changes until the next page is ready.
//
// Only a click that goes to a different PAGE counts; a filter, tab or sort that
// stays on the page keeps that page's own loading state.
function NavPendingProbe({ target }: { target: string }) {
  const { pending } = useLinkStatus()

  useEffect(() => {
    if (!pending || !leavesThisPage(target, window.location.href)) return
    // The returned function runs when the wait ends, and when the link goes
    // away together with the old page.
    return beginNavWait(document.documentElement)
  }, [pending, target])

  return null
}

/**
 * The app's only link: next/link with background loading turned OFF. A page
 * loads when the person clicks it, never in advance.
 *
 * OWNER DECISION (2026-11-12, "Yes, load on click"). Next's default Link loads
 * every page it points to as soon as the link is on screen, and each page
 * brings a stylesheet the current page never applies. Chrome logged those as
 * "preloaded but not used", and kept repeating each one as the person moved
 * around a long-open tab, so a few files became dozens of warnings on every
 * page. Narrowing WHEN pages load (#649 to #659) cut it down but could not end
 * it; not loading them in advance does. The cost, accepted: the first click to
 * a page waits for it (its loading skeleton shows) instead of being ready.
 *
 * `prefetch` is forced, after the caller's props, so no caller can turn it back
 * on. Every other prop passes through, `ref` included (React 19).
 *
 * It also shows the BOE One loader when a click is slow (NavPendingProbe above).
 *
 * Use it as `import { AppLink as Link } from '@/components/ui/AppLink'`. Guard:
 * src/lib/navigation/noBackgroundPrefetch.test.ts.
 */
export function AppLink(props: React.ComponentProps<typeof Link>) {
  const { href } = props
  const target = typeof href === 'string' ? href : href.pathname ?? ''
  return (
    <Link {...props} prefetch={false}>
      {props.children}
      <NavPendingProbe target={target} />
    </Link>
  )
}
