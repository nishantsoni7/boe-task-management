'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { MULTILINE_TEXT_RULES } from './MultilineText'
import { colors, font } from '@/lib/tokens'

// ─── ExpandableText ───────────────────────────────────────────────────────────
// MultilineText, plus a ceiling.
//
// A comment in the activity feed is stored and shown in full, and a long one
// pushed every other event off the screen — the feed stopped being a feed and
// became one message. This clamps the text to a few lines and offers "Read
// more…"; nothing is truncated in the DOM, so expanding is instant and a
// browser's find-in-page still reaches the hidden lines.
//
// ── WHY THE TOGGLE IS MEASURED, NOT COUNTED ─────────────────────────────────
//
// "Longer than 8 lines" is a question about the RENDERED box, not about the
// string: one typed line wraps to four on a phone and stays one on a desktop,
// and `\n` counting would offer "Read more…" on text that is already fully
// visible — the one outcome worse than no toggle at all. So the clamp is CSS
// (`-webkit-line-clamp`, which every browser this product supports honours) and
// the toggle appears only when the element reports that it actually overflowed.
//
// Re-measured on resize, because a window narrowed to half its width turns a
// 6-line comment into a 10-line one and the toggle has to appear.
//
// ── WHAT HAPPENS WHEN MEASUREMENT CANNOT RUN ────────────────────────────────
//
// Server rendering and the first client paint have no layout, so `overflowing`
// starts false and no toggle is drawn. The clamp itself is pure CSS and applies
// regardless — the text is never left uncapped while JavaScript catches up.
// Worst case (a browser with no ResizeObserver) the toggle stops updating on
// resize; it is still correct for the width it was measured at.

/** The feed's ceiling: enough for a real update, short enough to scan past. */
export const ACTIVITY_TEXT_CLAMP_LINES = 8

export function ExpandableText({
  children,
  style,
  clampLines = ACTIVITY_TEXT_CLAMP_LINES,
  moreLabel = 'Read more…',
  lessLabel = 'Show less',
  toggleStyle,
}: {
  children: ReactNode
  style?: CSSProperties
  clampLines?: number
  moreLabel?: string
  lessLabel?: string
  toggleStyle?: CSSProperties
}) {
  const ref = useRef<HTMLParagraphElement | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    // A clamped element reports the full height in scrollHeight and the capped
    // height in clientHeight. One pixel of slack absorbs sub-pixel line boxes,
    // which otherwise report a permanent 0.5px "overflow" on some zoom levels.
    setOverflowing(el.scrollHeight - el.clientHeight > 1)
  }, [])

  useEffect(() => {
    // Only meaningful while the clamp is on: an expanded element never
    // overflows, so measuring it would hide the "Show less" that undoes the
    // expansion. The last clamped measurement is kept instead.
    if (expanded) return
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [children, clampLines, expanded, measure])

  const clamp: CSSProperties = expanded ? {} : {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: clampLines,
    overflow: 'hidden',
  }

  return (
    <>
      <p ref={ref} style={{ ...style, ...MULTILINE_TEXT_RULES, ...clamp }}>
        {children}
      </p>
      {overflowing && (
        <button
          type="button"
          // The control's STATE, not just its label. A screen reader otherwise
          // announces "Read more…, button" and says nothing about what changed
          // when it is activated.
          aria-expanded={expanded}
          onClick={() => setExpanded(v => !v)}
          style={{
            display: 'block', marginTop: '4px', padding: 0,
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: '11.5px', fontWeight: 600, color: colors.blue,
            fontFamily: font.body, textAlign: 'left',
            ...toggleStyle,
          }}
        >
          {expanded ? lessLabel : moreLabel}
        </button>
      )}
    </>
  )
}
