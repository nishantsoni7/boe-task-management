'use client'

// Recovers a tab after a deployment or a stalled navigation. The rules and the
// measurements behind them are in src/lib/navigation/tabRecovery.ts.
//
// It never interrupts somebody mid-task: a quiet reload happens only while the
// tab is hidden and nothing on it is unsaved; otherwise it shows a small notice
// that the person can act on or ignore.

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import {
  RECHECK_WHILE_HIDDEN_MS, STALL_MS, coversScreen, decideFreshness, hasUnsavedWork, isBlockingLayer, isWriteRequest, parseDeploymentId,
  shouldCheckOnReturn, type PageWorkSignals,
} from '@/lib/navigation/tabRecovery'

// A stall notice remembers the page it was raised on and is shown only while the
// reader is still there — a route change hides it without any state update.
type Notice = { kind: 'updated' } | { kind: 'stalled'; href: string; from: string } | null

function ownDeployment(): string | null {
  const s = document.querySelector('script[src*="dpl="]') as HTMLScriptElement | null
  return parseDeploymentId(s?.src.match(/[?&]dpl=(dpl_[A-Za-z0-9]+)/)?.[1] ?? null)
}

// ── What a reload could lose that the DOM does not show ─────────────────────
// Writes in flight and the page's own "leave site?" guards are only visible at
// the moment they start, so they are counted from the first import of this
// module — before any page mounts. Both wrappers only count; every call still
// goes to the browser's own fetch / addEventListener unchanged.
type WorkCounters = { writes: number; leaveGuards: Set<EventListenerOrEventListenerObject> }

// Kept on window so a second copy of this module (a hot reload) shares the
// counters instead of wrapping fetch twice.
function countWork(): WorkCounters {
  const w = window as Window & { __boeWork?: WorkCounters }
  if (w.__boeWork) return w.__boeWork
  const counters: WorkCounters = { writes: 0, leaveGuards: new Set() }
  w.__boeWork = counters
  const browserFetch = window.fetch
  window.fetch = function countedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const method = init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
    if (!isWriteRequest(method)) return browserFetch.call(window, input, init)
    counters.writes++
    let settled = false
    const done = () => { if (!settled) { settled = true; counters.writes-- } }
    try {
      const pending = browserFetch.call(window, input, init)
      pending.then(done, done)
      return pending
    } catch (e) { done(); throw e }
  }
  const add = window.addEventListener
  const remove = window.removeEventListener
  window.addEventListener = function (this: Window, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if (this === window && type === 'beforeunload' && listener) counters.leaveGuards.add(listener)
    return add.call(this, type, listener as EventListenerOrEventListenerObject, options)
  } as typeof window.addEventListener
  window.removeEventListener = function (this: Window, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    if (this === window && type === 'beforeunload' && listener) counters.leaveGuards.delete(listener)
    return remove.call(this, type, listener as EventListenerOrEventListenerObject, options)
  } as typeof window.removeEventListener
  return counters
}

const inFlight: WorkCounters = typeof window === 'undefined' ? { writes: 0, leaveGuards: new Set() } : countWork()

const DIALOGS = '[role=dialog], [role=alertdialog], dialog[open], [aria-modal=true], .boe-modal-overlay, .order-modal-backdrop'
const TEXT_LIKE = /^(text|email|number|tel|url|date|time|datetime-local|month|week|password|)$/

function isShown(el: Element): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

/** Modals by role or class, plus the app's inline-styled ones: a fixed layer covering the screen. */
function openOverlays(): Element[] {
  const found = new Set<Element>()
  for (const el of document.querySelectorAll(DIALOGS)) if (isShown(el)) found.add(el)
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  for (const el of document.body.getElementsByTagName('*')) {
    // offsetParent is null for fixed elements (and hidden ones) — a cheap pre-filter.
    if ((el as HTMLElement).offsetParent !== null || el === document.body) continue
    if (!coversScreen(el.getBoundingClientRect(), viewport)) continue
    if (isBlockingLayer(getComputedStyle(el))) found.add(el)
  }
  return [...found]
}

function pageWorkSignals(editedSinceArrival: boolean, mutations: number): PageWorkSignals {
  const active = document.activeElement as HTMLElement | null
  const overlays = openOverlays()
  let chosenFiles = 0
  for (const f of document.querySelectorAll('input[type=file]')) chosenFiles += (f as HTMLInputElement).files?.length ?? 0
  let filledFormFields = 0
  for (const el of document.querySelectorAll('input, textarea')) {
    const field = el as HTMLInputElement | HTMLTextAreaElement
    if (field.disabled || field.readOnly || !field.value.trim()) continue
    if (field instanceof HTMLInputElement && !TEXT_LIKE.test(field.type)) continue
    if (field.closest('form') || overlays.some(o => o.contains(field))) filledFormFields++
  }
  return {
    editedSinceArrival,
    editableFocused: !!active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)),
    openOverlays: overlays.length,
    chosenFiles,
    pendingSaves: inFlight.writes + mutations,
    filledFormFields,
    leaveGuards: inFlight.leaveGuards.size + (typeof window.onbeforeunload === 'function' ? 1 : 0),
    declaredUnsaved: document.querySelectorAll('[data-unsaved="true"]').length,
  }
}

async function liveDeployment(): Promise<string | null> {
  try {
    const r = await fetch('/api/deployment', { cache: 'no-store' })
    if (!r.ok) return null
    return parseDeploymentId(((await r.json()) as { id?: unknown }).id)
  } catch { return null }
}

export function TabRecovery() {
  const pathname = usePathname()
  const queryClient = useQueryClient()
  const [notice, setNotice] = useState<Notice>(null)
  const hiddenAt = useRef<number | null>(null)
  const checking = useRef(false)
  const stallTimer = useRef<number | null>(null)
  // Anything typed or changed on the current page (reset when the route changes).
  const edited = useRef(false)

  useEffect(() => {
    const mark = (e: Event) => {
      const t = e.target as HTMLElement | null
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) edited.current = true
    }
    document.addEventListener('input', mark, true)
    document.addEventListener('change', mark, true)
    return () => { document.removeEventListener('input', mark, true); document.removeEventListener('change', mark, true) }
  }, [])

  // ── After a deployment ────────────────────────────────────────────────────
  useEffect(() => {
    const own = ownDeployment()
    if (!own) return // a local build without deployment ids: nothing to compare
    const check = async () => {
      if (checking.current) return
      checking.current = true
      try {
        const live = await liveDeployment()
        const decision = decideFreshness({ own, live, hidden: document.visibilityState === 'hidden', hasUnsavedWork: hasUnsavedWork(pageWorkSignals(edited.current, queryClient.isMutating())) })
        if (decision === 'reload-now') window.location.reload()
        else if (decision === 'offer-refresh') setNotice(n => n?.kind === 'stalled' ? n : { kind: 'updated' })
      } finally { checking.current = false }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { hiddenAt.current = performance.now(); return }
      const since = hiddenAt.current
      hiddenAt.current = null
      if (since != null && shouldCheckOnReturn(performance.now() - since)) void check()
    }
    // While hidden, look now and then, so the quiet reload happens before the
    // person comes back rather than as they return.
    const timer = window.setInterval(() => { if (document.visibilityState === 'hidden') void check() }, RECHECK_WHILE_HIDDEN_MS)
    document.addEventListener('visibilitychange', onVisibility)
    return () => { document.removeEventListener('visibilitychange', onVisibility); window.clearInterval(timer) }
  }, [queryClient])

  // ── A link that does not start ────────────────────────────────────────────
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || a.origin !== window.location.origin || a.target === '_blank' || a.hasAttribute('download')) return
      if (a.pathname === window.location.pathname) return
      const from = window.location.pathname
      const href = a.pathname + a.search + a.hash
      if (stallTimer.current != null) window.clearTimeout(stallTimer.current)
      stallTimer.current = window.setTimeout(() => {
        stallTimer.current = null
        if (window.location.pathname === from) setNotice({ kind: 'stalled', href, from })
      }, STALL_MS)
    }
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('click', onClick, true)
      if (stallTimer.current != null) window.clearTimeout(stallTimer.current)
    }
  }, [])

  // Any route change means the navigation did start: cancel a pending stall.
  // A new page also starts with nothing typed on it.
  useEffect(() => {
    if (stallTimer.current != null) { window.clearTimeout(stallTimer.current); stallTimer.current = null }
    edited.current = false
  }, [pathname])

  if (!notice) return null
  if (notice.kind === 'stalled' && notice.from !== pathname) return null
  const isStall = notice.kind === 'stalled'
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={isStall ? 'tab-recovery-stalled' : 'tab-recovery-updated'}
      style={{
        position: 'fixed', left: '50%', bottom: '20px', transform: 'translateX(-50%)', zIndex: 9998,
        display: 'flex', alignItems: 'center', gap: '12px', maxWidth: 'calc(100vw - 32px)',
        background: '#1F2937', color: '#fff', borderRadius: '10px', padding: '10px 12px 10px 16px',
        boxShadow: '0 6px 20px rgba(0,0,0,0.22)', fontSize: '13px',
      }}
    >
      <span>{isStall ? 'Still loading — the connection may have dropped.' : 'BOE has been updated.'}</span>
      <button
        type="button"
        className="boe-btn boe-btn-primary"
        style={{ minHeight: '36px', fontSize: '13px' }}
        onClick={() => { if (isStall) window.location.assign(notice.href); else window.location.reload() }}
      >
        {isStall ? 'Retry' : 'Refresh'}
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setNotice(null)}
        style={{ background: 'transparent', border: 0, color: '#9CA3AF', fontSize: '16px', cursor: 'pointer', minWidth: '32px', minHeight: '32px' }}
      >
        ✕
      </button>
    </div>
  )
}
