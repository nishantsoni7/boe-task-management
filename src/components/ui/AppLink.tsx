import Link from 'next/link'

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
 * Use it as `import { AppLink as Link } from '@/components/ui/AppLink'`. Guard:
 * src/lib/navigation/noBackgroundPrefetch.test.ts.
 */
export function AppLink(props: React.ComponentProps<typeof Link>) {
  return <Link {...props} prefetch={false} />
}
