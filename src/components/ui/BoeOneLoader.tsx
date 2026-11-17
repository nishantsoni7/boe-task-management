'use client'

import { useEffect, useId, useState, type CSSProperties } from 'react'
import { SPLASH_LABEL, type SplashKind } from '@/lib/dailySplash/kinds'

// The BOE One loading screen: the logo is drawn around its outline, floods to
// solid terracotta, takes one soft sweep of light, lets go, and starts again.
//
// WHEN IT SHOWS. Never at once. The layer is transparent for its first moments
// (CSS `--boe-loader-delay`, 0.8 s by default) and fades in only if the wait is
// real, so a page that arrives quickly never flashes it. That delay is CSS, not
// JavaScript, so it also works in the server-rendered HTML before any script
// has loaded, which is exactly when a slow connection needs it.
//
// THE MARK. `MARK` is the path of public/brand/svg/boe-one-symbol-charcoal.svg,
// unchanged (docs/BOE_VISUAL_IDENTITY.md: never redraw the logo), pinned by
// BoeOneLoader.test.tsx. Only the draw-in, the fill and the sweep are new.
//
// ONE COMPONENT, TWO PLACES. LoadingScreen (src/components/ui/atoms.tsx) renders
// it where a screen is waiting; the root layout renders one more, hidden, that
// AppLink reveals while a clicked link is waiting for its page
// (`html[data-boe-nav-pending]`, see globals.css).
const MARK =
  'M 620,854 H 370 Q 170,854 170,654 V 370 Q 170,170 370,170 H 654 Q 854,170 854,370 V 654 Q 854,816 684,849 V 410 Q 684,306 580,306 H 444 Q 306,306 306,444 V 580 Q 306,718 444,718 H 500 V 560 L 447,521 Q 427,506 446,489 L 582,370 Q 620,337 620,389 Z'

// One line at a time under the logo, each 4.5 s, in this order and then round
// again. The first ones carry most of the weight: most waits are over in under
// ten seconds. The cycle length in globals.css (36 s) and its 12.5% fade-out
// step are this list's SLOT COUNT times 4.5 s, and 100 / slots;
// BoeOneLoader.test.tsx fails if the list and the CSS drift apart.
//
// THESE EIGHT ARE THE FALLBACK, NOT THE SHOW. Because most waits end within two
// lines, a fixed list meant everyone saw the same two sentences every time. So
// the markup is rendered with these (fixed order, no random: the server and the
// first browser render must agree), and right after mount the browser swaps
// them for LOADER_LINE_COUNT (8) lines drawn from the library in
// src/lib/dailySplash: fun facts, one-liners, jingles, work hacks, trade facts,
// quotes and, when one has been fetched, a news headline. Without JavaScript,
// or before it arrives, these still show. Keep each at 60 characters or fewer.
export const CHEER_LINES = [
  'Good things take a moment. This one’s worth it.',
  'Take a breath. Your next win is almost here.',
  'Slow internet, strong spirit. You’ve got this.',
  'A sip of chai, and we’re right back.',
  'Great exports are built on patience. So is this page.',
  'Big things are being put together just for you.',
  'You’re about to get something done. Drumroll, please.',
  'Hang in there. The best part is still arriving.',
]

type LoaderLine = { text: string; kind?: SplashKind; by?: string }

// What the first render shows: the fixed fallback, no label.
const FALLBACK: readonly LoaderLine[] = CHEER_LINES.map(text => ({ text }))

// The copy in the root layout is hidden until a clicked link waits for its page
// (<html data-boe-nav-pending>). It is mounted once per visit, so it draws a
// fresh set each time it is revealed, not once.
const NAV_PENDING = 'data-boe-nav-pending'

export function BoeOneLoader({
  message,
  cheer = true,
  className,
}: {
  message?: string
  /** The rotating one-liners under the logo. Off where the screen is not a wait. */
  cheer?: boolean
  className?: string
}) {
  // Unique per copy: the clip and the gradient are looked up by id, and the
  // page can hold two loaders (the hidden one in the root layout and a screen's).
  const id = useId()
  const clip = `${id}-clip`
  const sheen = `${id}-sheen`

  const [lines, setLines] = useState<readonly LoaderLine[]>(FALLBACK)
  const isNavCopy = className === 'boe-nav-loader'
  useEffect(() => {
    if (!cheer) return
    let alive = true
    // THE LIBRARY IS A SEPARATE CHUNK. This component is in the root layout, so a
    // static import would put ~13 KB (gzipped) of lines on EVERY page. It is
    // fetched only when a loader is about to be seen: at once for a screen's own
    // loader, and for the hidden copy only when a slow click reveals it. The first
    // line shows 1.8 s after the loader starts, long after the chunk lands; if
    // it cannot load, the fixed lines stay.
    const redraw = () => {
      import('@/lib/dailySplash/splash')
        .then(lib => {
          if (!alive) return
          const storage = lib.browserStorage()
          setLines(lib.drawLoaderLines(storage ? lib.readHeadlines(storage, Date.now()) : []))
        })
        .catch(() => { /* the fixed lines stay */ })
    }
    let watcher: MutationObserver | undefined
    if (isNavCopy) {
      watcher = new MutationObserver(() => {
        if (document.documentElement.hasAttribute(NAV_PENDING)) redraw()
      })
      watcher.observe(document.documentElement, { attributes: true, attributeFilter: [NAV_PENDING] })
    } else {
      redraw()
    }
    return () => {
      alive = false
      watcher?.disconnect()
    }
  }, [cheer, isNavCopy])

  return (
    <div className={className ? `boe-loader ${className}` : 'boe-loader'} role="status" aria-live="polite">
      <svg className="boe-loader-mark" viewBox="130 130 764 764" aria-hidden="true">
        <defs>
          <clipPath id={clip}>
            <path d={MARK} />
          </clipPath>
          <linearGradient id={sheen} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset=".5" stopColor="#fff" stopOpacity=".42" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path className="boe-loader-fill" d={MARK} />
        <g clipPath={`url(#${clip})`}>
          <g className="boe-loader-sheen">
            <rect x="100" y="100" width="170" height="824" fill={`url(#${sheen})`} transform="skewX(-16)" />
          </g>
        </g>
        <path className="boe-loader-trace" pathLength={1} d={MARK} />
      </svg>
      {message ? <p className="boe-loader-text">{message}</p> : null}
      {/* Decoration for the eyes: a screen reader hears "Loading", not a joke every 4.5 s. */}
      {cheer ? (
        <div className="boe-loader-lines" aria-hidden="true">
          {lines.map((line, i) => (
            <p key={line.text} className="boe-loader-line" style={{ '--i': i } as CSSProperties}>
              {line.kind ? <span className="boe-loader-kind">{SPLASH_LABEL[line.kind]}</span> : null}
              {line.text}
              {line.by ? <span className="boe-loader-by">{' · '}{line.by}</span> : null}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}
