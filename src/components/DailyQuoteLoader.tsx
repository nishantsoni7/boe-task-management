'use client'

import { useEffect, useLayoutEffect, useState } from 'react'
import { SPLASH_LABEL, type SplashItem } from '@/lib/dailySplash/items'
import { browserStorage, chooseTodaysSplash, refreshHeadlines, splashDurationMs } from '@/lib/dailySplash/splash'

// The phase decision reads localStorage, so it can only run on the client. It
// must also run BEFORE the browser paints, otherwise the page underneath would
// be visible for one frame before the splash covers it. useLayoutEffect gives us
// that; useEffect on the server avoids React's "useLayoutEffect does nothing on
// the server" warning during the static prerender.
const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect

// What the splash says lives in src/lib/dailySplash: ~300 fun facts, one-liners,
// jingles, work hacks, trade facts and quotes, plus an "In the news" headline
// when one has been fetched. It used to be 50 fixed quotes picked by the day of
// the year (the same line for everyone, the list back every 50 days); now each
// browser remembers what it has shown and draws from what it has not.

function getTodayKey() {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm   = String(d.getMonth() + 1).padStart(2, '0')
  const dd   = String(d.getDate()).padStart(2, '0')
  return `boe_daily_quote_seen_${yyyy}-${mm}-${dd}`
}

// How long before the end the fade-out starts. The splash is on screen for
// splashDurationMs(item): 2.5 s for a short line, longer for a long one.
const FADE_OUT_MS = 400

// ── Why the children are mounted underneath the splash ───────────────────────
//
// This component used to return `null` during `check` and the overlay alone
// during `quote`, so its children — the whole of /modules — did not MOUNT until
// it was finished. Two costs came out of that:
//
//   · the statically prerendered /modules document had an empty <body>, so
//     there was nothing on screen until the JS had loaded and hydrated; and
//   · on the first visit of each day the page did not begin loading its own
//     data until the 2.5s quote had finished, making the quote pure added
//     latency rather than something to look at while the page loads.
//
// Children are now always rendered and the splash sits on top of them, so the
// page loads underneath it and is ready when it lifts. Nothing about the splash
// itself changed there: same design, same once-per-day localStorage key.
//
// COVERING IS NOT ENOUGH — the overlay must also make what is beneath it
// unreachable. It already blocked the mouse by being opaque and on top; while
// it is up the children are additionally marked `inert`, which removes them
// from the tab order, from hit-testing and from the accessibility tree in one
// step. Without that, Tab would walk into a page the user cannot see and a
// screen reader would read it out from behind the splash.
//
// The wrapper carrying `inert` uses `display: contents`, so it generates no box
// of its own and the layout underneath is byte-for-byte what it was before.
export default function DailyQuoteLoader({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<'check' | 'quote' | 'done'>('check')
  const [visible, setVisible] = useState(false)
  const [item, setItem] = useState<SplashItem | null>(null)

  useIsomorphicLayoutEffect(() => {
    const key = getTodayKey()

    // localStorage throws rather than returns null in a few real situations —
    // Safari's private mode on older versions, and any browser with site data
    // blocked. A splash is not worth breaking the launcher over, so a failed
    // READ is treated as "not seen yet" and a failed WRITE is swallowed below.
    let alreadySeen = false
    try {
      alreadySeen = !!localStorage.getItem(key)
    } catch {
      alreadySeen = false
    }

    if (alreadySeen) {
      setPhase('done')
      return
    }

    // ── PERSIST NOW, NOT WHEN THE TIMER FINISHES ──────────────────────────────
    //
    // This write used to live in the 2.5s `finish` timeout, which the cleanup
    // below clears on unmount. So anything that ended the page early — a hard
    // refresh, browser Back, closing the tab, any navigation — meant the key
    // was never written and the splash played AGAIN on the next visit that day.
    // "Once per day" only held if you sat and watched it to the end.
    //
    // Recording it at the moment it is shown is what makes the once-per-day
    // promise actually true, and is what stops the splash from delaying repeat
    // navigation back to /modules. The line it shows is remembered at the same
    // moment, for the same reason.
    try {
      localStorage.setItem(key, '1')
    } catch {
      // Storage unavailable. The splash still shows; it may show again later.
    }

    const today = chooseTodaysSplash(browserStorage())
    const total = splashDurationMs(today)
    setItem(today)
    setPhase('quote')
    // Fade in
    const fadeIn = setTimeout(() => setVisible(true), 30)
    // Start the fade out shortly before the end, then hand the page back
    const fadeOut = setTimeout(() => setVisible(false), total - FADE_OUT_MS)
    const finish  = setTimeout(() => {
      setPhase('done')
    }, total)

    return () => {
      clearTimeout(fadeIn)
      clearTimeout(fadeOut)
      clearTimeout(finish)
    }
  }, [])

  // A longer line stays up longer, so it can be dismissed: a tap anywhere, or
  // Escape / Enter / Space. The timers above still fire afterwards; they only
  // set state that is already what they set.
  useEffect(() => {
    if (phase !== 'quote') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') setPhase('done')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase])

  // Fetch tomorrow's "In the news" headline in the background. Never on the way
  // to the splash (nothing here waits on the network) and not while the page is
  // still loading its own data: a few seconds after mount, at most every six
  // hours per browser.
  useEffect(() => {
    const storage = browserStorage()
    if (!storage) return
    const t = setTimeout(() => { void refreshHeadlines(storage, fetch) }, 4000)
    return () => clearTimeout(t)
  }, [])

  // `check` ends in the layout effect above, i.e. before the first paint, so it
  // is never a state the user sees on the client. On the server it is the only
  // state there is — and rendering the children through it is what puts real
  // markup into the prerendered /modules document instead of an empty body.
  const overlayUp = phase === 'quote' && item !== null

  return (
    <>
      {/* `display: contents` generates no box, so the layout beneath is exactly
          what it was before this wrapper existed. While the splash is up the
          subtree is hidden (so the fade-in still reveals the same plain page
          background it always did, with no flash of the page) and `inert` (so
          it cannot be tabbed into, clicked, focused, or read by a screen
          reader). Neither property stops it MOUNTING, which is the point: the
          page loads its data underneath and is ready when the splash lifts. */}
      <div
        style={{ display: 'contents', ...(overlayUp ? { visibility: 'hidden' as const } : {}) }}
        inert={overlayUp}
      >
        {children}
      </div>
      {overlayUp && (
        <SplashOverlay
          item={item}
          visible={visible}
          durationMs={splashDurationMs(item)}
          onSkip={() => setPhase('done')}
        />
      )}
    </>
  )
}

function SplashOverlay({ item, visible, durationMs, onSkip }: {
  item: SplashItem
  visible: boolean
  durationMs: number
  onSkip: () => void
}) {
  return (
    <div
      role="status"
      aria-label="Daily splash"
      onClick={onSkip}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#F7F5F1',
        zIndex: 9999,
        padding: '32px 24px',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.4s ease',
        cursor: 'pointer',
      }}>
        {/* BOE One logo */}
        <div style={{ marginBottom: '48px' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/svg/boe-one-logo-horizontal-light.svg"
            alt="BOE One"
            width={1220}
            height={330}
            style={{ maxWidth: '240px', width: '100%', height: 'auto' }}
          />
        </div>

        {/* What kind of line this is: Fun fact, Jingle, In the news... */}
        <div style={{
          fontSize: '12px',
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: '#B9472E',
          marginBottom: '16px',
        }}>
          {SPLASH_LABEL[item.kind]}
        </div>

        {/* The line */}
        <p style={{
          fontSize: 'clamp(18px, 4vw, 26px)',
          fontFamily: 'var(--font-display)',
          fontWeight: 600,
          color: '#303536',
          lineHeight: 1.55,
          textAlign: 'center',
          maxWidth: '520px',
          margin: item.by ? '0 0 12px' : '0 0 48px',
          letterSpacing: '-0.01em',
        }}>
          {item.text}
        </p>

        {/* A quote's author, or a headline's publisher */}
        {item.by && (
          <p style={{ fontSize: '14px', color: '#686D6C', margin: '0 0 36px', textAlign: 'center' }}>
            &mdash; {item.by}
          </p>
        )}

        {/* Progress bar */}
        <div style={{
          width: '40px',
          height: '2px',
          background: '#E4DED7',
          borderRadius: '999px',
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            background: '#B9472E',
            borderRadius: '999px',
            animation: `boe-progress ${durationMs - FADE_OUT_MS}ms linear forwards`,
          }} />
        </div>

        <div aria-hidden="true" style={{ marginTop: '16px', fontSize: '11px', color: '#686D6C' }}>
          Tap to skip
        </div>

        <style>{`
          @keyframes boe-progress {
            from { width: 0% }
            to   { width: 100% }
          }
        `}</style>
    </div>
  )
}
