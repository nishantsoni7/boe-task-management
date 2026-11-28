'use client'

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { beginNavWait, leavesThisPage } from '@/lib/navigation/navWait'

// EVERY MOVE TO ANOTHER PAGE SHOWS THE BOE ONE LOADER WHEN IT IS SLOW (28 Nov 2026).
//
// AppLink (a clicked link) always did. But 195 files move with router.push /
// router.replace instead: the global Back button, a table row, a save that sends
// you on. Those never told the loader anything, so a slow one left the old page
// on screen, unchanged, until the next one was ready.
//
// This provider sits above the whole app and hands every descendant a router
// whose push and replace mark <html> (src/lib/navigation/navWait.ts) when the
// move leaves the current page. globals.css turns the mark into the full-screen
// loader after its own 1.2 s pause, so a quick move never flashes it. Next's
// useRouter() reads AppRouterContext, so none of the 195 call sites changes.
//
// ENDS when the new page has arrived (the pathname changes), or after
// NAV_WAIT_GIVE_UP_MS so a move that never arrives cannot leave the loader up.
//
// BACK AND FORWARD are caught by the browser's popstate instead of by
// router.back(), so the browser's own Back button is covered too. Only a change of
// PAGE counts, as for a link: a filter or tab that moves the query string keeps
// that page's own loading state.
//
// Guard: src/components/layout/NavWaitRouter.dom.test.tsx.

/** A move that has not arrived by now is given up, so the loader cannot stay on for ever. */
export const NAV_WAIT_GIVE_UP_MS = 15_000

export function NavWaitRouter({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const waits = useRef(new Set<() => void>())
  // The page on screen: what a popstate is compared with (the address bar has already changed by then).
  const shown = useRef(pathname)

  const start = useCallback(() => {
    const end = beginNavWait(document.documentElement)
    const set = waits.current
    let timer = 0
    const done = () => { window.clearTimeout(timer); set.delete(done); end() }
    timer = window.setTimeout(done, NAV_WAIT_GIVE_UP_MS)
    set.add(done)
  }, [])

  // A new page has arrived: every wait is over.
  useEffect(() => {
    shown.current = pathname
    for (const done of [...waits.current]) done()
  }, [pathname])

  // Back, Forward and the browser's own buttons: the address has changed, the page has not yet.
  useEffect(() => {
    const onPop = () => { if (window.location.pathname !== shown.current) start() }
    window.addEventListener('popstate', onPop)
    const open = waits.current
    return () => {
      window.removeEventListener('popstate', onPop)
      for (const done of [...open]) done()
    }
  }, [start])

  const wrapped = useMemo<AppRouterInstance>(() => {
    const leaves = (href: string) => leavesThisPage(href, window.location.href)
    return {
      ...router,
      push: (href, options) => { if (leaves(href)) start(); router.push(href, options) },
      replace: (href, options) => { if (leaves(href)) start(); router.replace(href, options) },
    }
  }, [router, start])

  return <AppRouterContext.Provider value={wrapped}>{children}</AppRouterContext.Provider>
}
