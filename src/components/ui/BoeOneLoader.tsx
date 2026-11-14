import { useId, type CSSProperties } from 'react'

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
// ten seconds. Fixed order on purpose (no random): the same markup must come out
// on the server and in the browser. The cycle length in globals.css (36 s) and
// its 12.5% fade-out step are this list's length times 4.5 s, and 100 / length;
// BoeOneLoader.test.tsx fails if the list and the CSS drift apart.
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
          {CHEER_LINES.map((line, i) => (
            <p key={line} className="boe-loader-line" style={{ '--i': i } as CSSProperties}>
              {line}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}
