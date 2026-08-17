'use client'

import { useEffect, useLayoutEffect, useState } from 'react'

// The phase decision reads localStorage, so it can only run on the client. It
// must also run BEFORE the browser paints, otherwise the page underneath would
// be visible for one frame before the quote covers it. useLayoutEffect gives us
// that; useEffect on the server avoids React's "useLayoutEffect does nothing on
// the server" warning during the static prerender.
const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect

const QUOTES = [
  "Small steps every day lead to big results over time.",
  "Your work today shapes the success of tomorrow.",
  "Focus on progress, not perfection.",
  "Every task completed is a step forward.",
  "Consistency beats intensity — show up every day.",
  "Clarity of purpose turns hard work into great work.",
  "Effort compounds. What you do today multiplies.",
  "Do it with intention and it will make a difference.",
  "Great teams are built one reliable person at a time.",
  "Your attitude at the start determines the outcome.",
  "Begin with energy. The momentum will carry you.",
  "Discipline is the bridge between goals and achievement.",
  "Small wins build the confidence for bigger ones.",
  "The best time to be productive is right now.",
  "Pursue excellence quietly — results will speak loudly.",
  "Make today count. Future you is watching.",
  "A clear mind is more powerful than a busy one.",
  "Be the person your team can count on.",
  "Good work is its own reward — do it anyway.",
  "One focused hour beats three distracted ones.",
  "Challenges are feedback in disguise.",
  "Trust the process. Growth is rarely visible in the moment.",
  "Bring your full self to work — it matters.",
  "Every expert was once a beginner who kept going.",
  "Kindness and quality at work are never wasted.",
  "Today is a fresh chance to do something great.",
  "Precision and care in small tasks build a great reputation.",
  "Hard work is a quiet form of respect for the craft.",
  "Your energy sets the tone for those around you.",
  "Start before you feel ready — momentum follows action.",
  "Difficulties reveal strengths you didn't know you had.",
  "A great day starts with a clear first task.",
  "Execution is the strategy that actually works.",
  "Show up fully and let the results follow.",
  "Reliable people move the world forward.",
  "Excellence is a habit, not a destination.",
  "Make the mundane meaningful — it all adds up.",
  "Teamwork compounds individual effort.",
  "The work you put in today is tomorrow's foundation.",
  "Purpose turns ordinary tasks into meaningful ones.",
  "Stay curious. The best ideas come from unexpected places.",
  "A calm approach solves most problems faster.",
  "Progress, however small, is still progress.",
  "Invest your focus where it matters most today.",
  "Good enough can always become better — start somewhere.",
  "Patience with the process is a professional skill.",
  "You set the standard for what great looks like here.",
  "Each completed task is a promise kept to yourself.",
  "The difference is in the details — take care of them.",
]

function getTodayKey() {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm   = String(d.getMonth() + 1).padStart(2, '0')
  const dd   = String(d.getDate()).padStart(2, '0')
  return `boe_daily_quote_seen_${yyyy}-${mm}-${dd}`
}

function getDailyQuote() {
  const d = new Date()
  // Use local date components only — avoids UTC-based day switching for IST users
  const startOfYear = new Date(d.getFullYear(), 0, 1)
  const dayOfYear =
    (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) -
     Date.UTC(startOfYear.getFullYear(), startOfYear.getMonth(), startOfYear.getDate())) /
    86_400_000
  return QUOTES[dayOfYear % QUOTES.length]
}

// ── Why the children are mounted underneath the quote ────────────────────────
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
// Children are now always rendered and the quote sits on top of them, so the
// page loads underneath it and is ready when it lifts. Nothing about the quote
// itself changed: same design, same 2.5s, same once-per-day localStorage key.
//
// COVERING IS NOT ENOUGH — the overlay must also make what is beneath it
// unreachable. It already blocked the mouse by being opaque and on top; while
// it is up the children are additionally marked `inert`, which removes them
// from the tab order, from hit-testing and from the accessibility tree in one
// step. Without that, Tab would walk into a page the user cannot see and a
// screen reader would read it out from behind the quote.
//
// The wrapper carrying `inert` uses `display: contents`, so it generates no box
// of its own and the layout underneath is byte-for-byte what it was before.
export default function DailyQuoteLoader({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<'check' | 'quote' | 'done'>('check')
  const [visible, setVisible] = useState(false)

  useIsomorphicLayoutEffect(() => {
    const key = getTodayKey()

    // localStorage throws rather than returns null in a few real situations —
    // Safari's private mode on older versions, and any browser with site data
    // blocked. A quote is not worth breaking the launcher over, so a failed
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
    // was never written and the quote played AGAIN on the next visit that day.
    // "Once per day" only held if you sat and watched it to the end.
    //
    // Recording it at the moment it is shown is what makes the once-per-day
    // promise actually true, and is what stops the quote from delaying repeat
    // navigation back to /modules. Nothing else moves: same key, same local
    // calendar day, same 2.5s presentation, same visuals.
    try {
      localStorage.setItem(key, '1')
    } catch {
      // Storage unavailable. The quote still shows; it may show again later.
    }

    setPhase('quote')
    // Fade in
    const fadeIn = setTimeout(() => setVisible(true), 30)
    // Start fade out at 2.1s, then hand the page back at 2.5s
    const fadeOut = setTimeout(() => setVisible(false), 2100)
    const finish  = setTimeout(() => {
      setPhase('done')
    }, 2500)

    return () => {
      clearTimeout(fadeIn)
      clearTimeout(fadeOut)
      clearTimeout(finish)
    }
  }, [])

  // `check` ends in the layout effect above, i.e. before the first paint, so it
  // is never a state the user sees on the client. On the server it is the only
  // state there is — and rendering the children through it is what puts real
  // markup into the prerendered /modules document instead of an empty body.
  const overlayUp = phase === 'quote'

  return (
    <>
      {/* `display: contents` generates no box, so the layout beneath is exactly
          what it was before this wrapper existed. While the quote is up the
          subtree is hidden (so the fade-in still reveals the same plain page
          background it always did, with no flash of the page) and `inert` (so
          it cannot be tabbed into, clicked, focused, or read by a screen
          reader). Neither property stops it MOUNTING, which is the point: the
          page loads its data underneath and is ready when the quote lifts. */}
      <div
        style={{ display: 'contents', ...(overlayUp ? { visibility: 'hidden' as const } : {}) }}
        inert={overlayUp}
      >
        {children}
      </div>
      {overlayUp && <QuoteOverlay visible={visible} />}
    </>
  )
}

function QuoteOverlay({ visible }: { visible: boolean }) {
  const quote = getDailyQuote()
  return (
    <div
      role="status"
      aria-label="Daily quote"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0F1422',
        zIndex: 9999,
        padding: '32px 24px',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.4s ease',
      }}>
        {/* BOE logo */}
        <div style={{ marginBottom: '48px' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/branding/boe-logo-white.png"
            alt="Best of Exports"
            style={{ maxWidth: '180px', width: '100%', height: 'auto', opacity: 0.85 }}
          />
        </div>

        {/* Quote mark */}
        <div style={{
          fontSize: '64px',
          lineHeight: 1,
          color: '#1A2A4A',
          fontFamily: 'Georgia, serif',
          marginBottom: '16px',
          alignSelf: 'flex-start',
          maxWidth: '520px',
          width: '100%',
        }}>
          &ldquo;
        </div>

        {/* Quote text */}
        <p style={{
          fontSize: 'clamp(18px, 4vw, 26px)',
          fontWeight: 500,
          color: '#E2E8F0',
          lineHeight: 1.55,
          textAlign: 'center',
          maxWidth: '520px',
          margin: '0 0 48px',
          letterSpacing: '-0.01em',
        }}>
          {quote}
        </p>

        {/* Progress bar */}
        <div style={{
          width: '40px',
          height: '2px',
          background: '#1E3A5F',
          borderRadius: '999px',
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            background: '#4A90D9',
            borderRadius: '999px',
            animation: 'boe-progress 2.1s linear forwards',
          }} />
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
