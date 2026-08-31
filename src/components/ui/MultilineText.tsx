'use client'

import type { CSSProperties, ReactNode } from 'react'

// ─── MultilineText ────────────────────────────────────────────────────────────
// The shared renderer for user-entered task text: descriptions, comments and
// status notes. All of it is stored as plain text with real `\n` characters,
// which HTML collapses by default — so without this the three lines a user
// typed come back as one continuous paragraph.
//
//   • pre-wrap        keeps newlines and the blank lines between paragraphs
//   • overflow-wrap   lets an unbroken string (a long URL, a pasted reference
//                     number) break mid-word instead of scrolling the card
//
// Content stays plain text. React escapes it, so HTML-looking input such as
// `<b>hi</b>` is shown literally and is never interpreted as markup — this
// component deliberately does not use dangerouslySetInnerHTML.
//
// `style` is for the caller's typography (size, colour, margin, flex). The two
// whitespace rules are applied last so a caller cannot accidentally undo them.

/**
 * The two rules that make stored plain text render the way it was typed.
 *
 * Exported so a component that must build its own <p> — ExpandableText, which
 * needs a ref and a line clamp — applies the SAME contract instead of a copy
 * that can drift. Spread it LAST, for the reason in the header.
 */
export const MULTILINE_TEXT_RULES: CSSProperties = {
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}

export function MultilineText({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <p style={{ ...style, ...MULTILINE_TEXT_RULES }}>
      {children}
    </p>
  )
}
