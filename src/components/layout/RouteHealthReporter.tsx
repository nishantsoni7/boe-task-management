'use client'

// Records slow navigations and page errors as privacy-safe evidence.
// The rules — what is kept, what is scrubbed — live in src/lib/telemetry/routeHealth.ts.
//
// HOW A NAVIGATION IS TIMED
//   intent   a click on a same-site link or a button (capture phase), or Back/Forward;
//   route    the pathname changes (usePathname) and the new route is painted
//            (second animation frame);
//   content  the page then shows no loading marker (LOADING_SELECTOR, or a bare
//            "Loading…" label) for CONTENT_QUIET_MS — the moment it is usable.
// Only a wait of LONG_NAVIGATION_MS or more is reported. A LINK or Back/Forward
// that changes nothing for STALLED_NAVIGATION_MS is reported as stalled; a
// button may just open a dialog, so it is timed only if the route changes.
// Nothing about the page's data is read — only whether a loader is on screen.
//
// FIRST OPEN. The document report times navigation start → content ready, so the
// daily quote (which covers the page) is counted as part of the wait.
//
// It never blocks anything: every report goes through navigator.sendBeacon, at
// most MAX_REPORTS_PER_TAB per tab (counted across reloads), and a repeated
// error is sent once. Timing runs only while a navigation is in progress.
//
// ROUTES are named from the route's own parameters (useParams), so a dynamic
// segment is replaced exactly. Each report is also kept on this device
// (routeHealthLocal) because the server's log lasts an hour on this plan.

import { useEffect, useRef } from 'react'
import { useParams, usePathname } from 'next/navigation'
import {
  CONTENT_GIVE_UP_MS, CONTENT_QUIET_MS, LOADING_SELECTOR, LOADING_TEXT, LONG_NAVIGATION_MS,
  MAX_REPORTS_PER_TAB, MAX_REPORT_BYTES, STALLED_NAVIGATION_MS,
  documentReport, errorReport, navigationReport, templateFromParams, type NetworkHint, type RouteHealthReport,
} from '@/lib/telemetry/routeHealth'
import { keepLocally } from '@/components/layout/routeHealthLocal'

const ENDPOINT = '/api/client-health'
const SENT_KEY = 'boe_route_health_sent'

/** Reports already sent from this tab, surviving reloads; a blocked store counts as full. */
function sentFromTab(): number {
  try { return Number(sessionStorage.getItem(SENT_KEY) ?? '0') || 0 } catch { return MAX_REPORTS_PER_TAB }
}
function countSent(n: number) {
  try { sessionStorage.setItem(SENT_KEY, String(n)) } catch { /* best-effort */ }
}

function deploymentId(): string | null {
  const s = document.querySelector('script[src*="dpl="]') as HTMLScriptElement | null
  return s?.src.match(/[?&]dpl=(dpl_[A-Za-z0-9]+)/)?.[1] ?? null
}

function networkHint(): NetworkHint {
  const c = (navigator as Navigator & { connection?: { effectiveType?: string; rtt?: number } }).connection
  return { effectiveType: c?.effectiveType ?? null, rttMs: typeof c?.rtt === 'number' ? c.rtt : null }
}

const visible = () => document.visibilityState === 'visible'
const afterPaint = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn))

function onScreen(el: Element): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

/** Is anything on screen still saying "loading"? */
function stillLoading(): boolean {
  for (const el of document.querySelectorAll(LOADING_SELECTOR)) if (onScreen(el)) return true
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent?.trim()
    if (text && text.length <= 10 && LOADING_TEXT.test(text) && n.parentElement && onScreen(n.parentElement)) return true
  }
  return false
}

/** Resolves with performance.now() when the page has shown no loader for CONTENT_QUIET_MS, or null. */
function whenContentReady(startedAt: number, isCurrent: () => boolean): Promise<number | null> {
  return new Promise(resolve => {
    let quietSince: number | null = null
    const tick = () => {
      if (!isCurrent()) return resolve(null)
      const now = performance.now()
      if (now - startedAt > CONTENT_GIVE_UP_MS) return resolve(null)
      if (stillLoading()) quietSince = null
      else if (quietSince == null) quietSince = now
      else if (now - quietSince >= CONTENT_QUIET_MS) return resolve(quietSince)
      window.setTimeout(tick, 100)
    }
    tick()
  })
}

export function RouteHealthReporter() {
  const pathname = usePathname()
  const params = useParams()
  // The CURRENT route's template, updated after each route commits. Read at
  // click / Back time — before React renders the next route — it is the page
  // being left. (At popstate, location already shows the destination.)
  const template = useRef('/')
  const seenErrors = useRef(new Set<string>())
  const pending = useRef<{ from: string; fromTemplate: string; at: number; visible: boolean; stallTimer: number | null } | null>(null)
  const generation = useRef(0)
  const firstRoute = useRef(true)

  const send = (report: RouteHealthReport | null) => {
    if (!report) return
    const sent = sentFromTab()
    if (sent >= MAX_REPORTS_PER_TAB) return
    const body = JSON.stringify(report)
    if (body.length > MAX_REPORT_BYTES) return
    countSent(sent + 1)
    keepLocally(report)
    try {
      if (!navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: 'application/json' }))) {
        void fetch(ENDPOINT, { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => {})
      }
    } catch { /* evidence is best-effort; never let it affect the page */ }
  }

  // Intent: a click on something that can navigate, or Back/Forward.
  useEffect(() => {
    // `canStall`: only a same-site LINK or Back/Forward is certainly a navigation,
    // so only those can be reported as stalled. A button may just open a dialog;
    // it is timed only if the route actually changes.
    const begin = (canStall: boolean) => {
      if (pending.current?.stallTimer != null) window.clearTimeout(pending.current.stallTimer)
      const from = window.location.pathname
      const at = performance.now()
      const stallTimer = !canStall ? null : window.setTimeout(() => {
        const p = pending.current
        if (!p || p.at !== at || window.location.pathname !== p.from) return
        pending.current = null
        send(navigationReport({ fromPath: p.fromTemplate, toPath: p.fromTemplate, startedAt: p.at, endedAt: null, contentAt: null,
          visibleAtStart: p.visible, visibleAtEnd: visible(), hardLoad: false, network: networkHint(), deployment: deploymentId() }))
      }, STALLED_NAVIGATION_MS)
      pending.current = { from, fromTemplate: template.current, at, visible: visible(), stallTimer }
    }
    const onClick = (e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
      const el = (e.target as Element | null)?.closest?.('a[href], button, [role=button], [role=link]')
      if (!el) return
      if (el.tagName === 'A') {
        const a = el as HTMLAnchorElement
        // Links elsewhere, downloads and new-tab links are not navigations of this page.
        if (a.origin !== window.location.origin || a.target === '_blank' || a.hasAttribute('download')) return
        if (a.pathname === window.location.pathname) return
        begin(true)
        return
      }
      begin(false)
    }
    const onPop = () => begin(true)
    document.addEventListener('click', onClick, true)
    window.addEventListener('popstate', onPop)
    return () => { document.removeEventListener('click', onClick, true); window.removeEventListener('popstate', onPop) }
  }, [])

  // Declared before the timing effect below, so it runs first on each route.
  useEffect(() => {
    template.current = templateFromParams(pathname, params as Record<string, string | string[]>)
  }, [pathname, params])

  // The route changed (or the document's first route mounted): time route and content.
  useEffect(() => {
    const gen = ++generation.current
    const isCurrent = () => generation.current === gen

    if (firstRoute.current) {
      firstRoute.current = false
      afterPaint(() => {
        const firstRouteMs = performance.now()
        void whenContentReady(0, isCurrent).then(contentAt => {
          // The reader moved on before the first page settled: not a measurement.
          if (contentAt == null && !isCurrent() && firstRouteMs < LONG_NAVIGATION_MS) return
          const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
          send(documentReport({ path: template.current, firstRouteMs, contentMs: contentAt,
            responseEndMs: nav ? nav.responseEnd : null, visible: visible(), network: networkHint(), deployment: deploymentId() }))
        })
      })
      return
    }

    const p = pending.current
    if (!p) return
    pending.current = null
    if (p.stallTimer != null) window.clearTimeout(p.stallTimer)
    // A route change long after the last click was not caused by it.
    if (performance.now() - p.at > 60_000) return
    afterPaint(() => {
      const routeAt = performance.now()
      void whenContentReady(p.at, isCurrent).then(contentAt => {
        // A newer navigation took over: this one's content is not measurable.
        if (!isCurrent() && contentAt == null) return
        send(navigationReport({ fromPath: p.fromTemplate, toPath: template.current, startedAt: p.at, endedAt: routeAt, contentAt,
          visibleAtStart: p.visible, visibleAtEnd: visible(), hardLoad: false, network: networkHint(), deployment: deploymentId() }))
      })
    })
  }, [pathname])

  // Page errors, including render errors React reports as uncaught.
  useEffect(() => {
    const report = (message: unknown, name: unknown, source: unknown) => {
      const r = errorReport({ path: template.current, message, name, source, visible: visible(), deployment: deploymentId() })
      const key = `${r.route}|${r.message}`
      if (seenErrors.current.has(key)) return
      seenErrors.current.add(key)
      send(r)
    }
    const onError = (e: ErrorEvent) => report(e.error?.message ?? e.message, e.error?.name, e.filename)
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason as { message?: unknown; name?: unknown; stack?: unknown } | undefined
      const source = typeof reason?.stack === 'string' ? reason.stack.match(/\/_next\/static\/chunks\/[^\s):]+/)?.[0] : null
      report(reason?.message ?? reason, reason?.name, source)
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection) }
  }, [])

  return null
}

/** Exposed for the source-level test: a report below this is never sent. */
export const ROUTE_HEALTH_REPORT_THRESHOLD_MS = LONG_NAVIGATION_MS
