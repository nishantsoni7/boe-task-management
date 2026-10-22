'use client'

// Recovers a tab after a deployment or a stalled navigation. The rules and the
// measurements behind them are in src/lib/navigation/tabRecovery.ts.
//
// It never reloads on its own. A new deployment, or a link that has not moved,
// shows a small notice; the person chooses Refresh / Retry or dismisses it.

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import {
  RECHECK_WHILE_HIDDEN_MS, STALL_MS, decideFreshness, parseDeploymentId, shouldCheckOnReturn,
} from '@/lib/navigation/tabRecovery'

// A stall notice remembers the page it was raised on and is shown only while the
// reader is still there — a route change hides it without any state update.
type Notice = { kind: 'updated'; live: string } | { kind: 'stalled'; href: string; from: string } | null

function ownDeployment(): string | null {
  const s = document.querySelector('script[src*="dpl="]') as HTMLScriptElement | null
  return parseDeploymentId(s?.src.match(/[?&]dpl=(dpl_[A-Za-z0-9]+)/)?.[1] ?? null)
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
  const [notice, setNotice] = useState<Notice>(null)
  const hiddenAt = useRef<number | null>(null)
  const checking = useRef(false)
  const stallTimer = useRef<number | null>(null)
  // The deployment whose notice the person closed; it is not offered again.
  const dismissed = useRef<string | null>(null)

  // ── After a deployment ────────────────────────────────────────────────────
  useEffect(() => {
    const own = ownDeployment()
    if (!own) return // a local build without deployment ids: nothing to compare
    const check = async () => {
      if (checking.current) return
      checking.current = true
      try {
        const live = await liveDeployment()
        if (live && decideFreshness({ own, live, dismissed: dismissed.current }) === 'offer-refresh') {
          setNotice(n => n?.kind === 'stalled' ? n : { kind: 'updated', live })
        }
      } finally { checking.current = false }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { hiddenAt.current = performance.now(); return }
      const since = hiddenAt.current
      hiddenAt.current = null
      if (since != null && shouldCheckOnReturn(performance.now() - since)) void check()
    }
    // While hidden, look now and then, so the notice is already there when the
    // person comes back.
    const timer = window.setInterval(() => { if (document.visibilityState === 'hidden') void check() }, RECHECK_WHILE_HIDDEN_MS)
    document.addEventListener('visibilitychange', onVisibility)
    return () => { document.removeEventListener('visibilitychange', onVisibility); window.clearInterval(timer) }
  }, [])

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
  useEffect(() => {
    if (stallTimer.current != null) { window.clearTimeout(stallTimer.current); stallTimer.current = null }
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
      <span>{isStall ? 'Still loading — the connection may have dropped.' : 'BOE has been updated. Refresh when you are ready.'}</span>
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
        onClick={() => { if (notice.kind === 'updated') dismissed.current = notice.live; setNotice(null) }}
        style={{ background: 'transparent', border: 0, color: '#9CA3AF', fontSize: '16px', cursor: 'pointer', minWidth: '32px', minHeight: '32px' }}
      >
        ✕
      </button>
    </div>
  )
}
