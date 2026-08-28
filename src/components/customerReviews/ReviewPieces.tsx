'use client'

import { useState } from 'react'
import { AlertTriangle, Eye, EyeOff } from 'lucide-react'
import { colors } from '@/lib/tokens'
import type { BadgeMeta } from '@/lib/customerReviews/types'
import { formatWhatsAppNumber, maskWhatsAppNumber } from '@/lib/customerReviews/contact'
import { INTERNAL_TEST_WARNING } from '@/lib/customerReviews/internalTest'

// Small pieces shared by the internal-test screens. Same visual language as
// MeetingBadge — a status wears one colour in the tab strip, the row and the
// detail header.

/**
 * THE MANDATORY LABEL, AS A COMPONENT.
 *
 * It renders INTERNAL_TEST_WARNING and NOTHING ELSE from the caller: there is
 * no `text` prop, no `children`, and no way to dim, shorten or suppress it. A
 * caller can decide WHERE it appears; it cannot decide WHAT it says.
 *
 * That is the whole design. The label has to survive an employee in a hurry, a
 * screenshot, and a future edit by somebody who does not know why it is there,
 * so it is a constant rendered by a component with no content parameter rather
 * than a string each screen remembers to include.
 *
 * It appears on every card in every list, at the top of every detail screen,
 * and above every message preview — and the message itself carries its own copy
 * (buildInternalTestMessage), because the message travels somewhere this
 * component cannot follow.
 */
export function InternalTestWarning({ compact = false }: { compact?: boolean }) {
  return (
    <div
      role="note"
      aria-label="Internal test only"
      style={{
        display: 'flex', gap: compact ? '6px' : '8px', alignItems: 'center',
        padding: compact ? '5px 8px' : '9px 12px',
        borderRadius: compact ? '6px' : '8px',
        background: '#FEF2F2',
        border: '1px solid #FECACA',
        color: '#991B1B',
        fontSize: compact ? '10px' : '12px',
        fontWeight: 700,
        letterSpacing: '0.01em',
        lineHeight: 1.4,
      }}
    >
      <AlertTriangle size={compact ? 12 : 14} strokeWidth={2.2} style={{ flexShrink: 0 }} />
      <span>{INTERNAL_TEST_WARNING}</span>
    </div>
  )
}

export function ReviewBadge({ meta }: { meta: BadgeMeta }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
      background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`,
      fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  )
}

/**
 * An internal team number, masked, with a deliberate reveal.
 *
 * Masked is the default everywhere, including for the person who chose it. The
 * reveal is a click rather than a hover so it cannot happen by accident while
 * somebody is scrolling past on a shared screen, and it is per-instance state
 * that resets on every navigation — there is no "remember revealed" anywhere.
 *
 * `revealable` is false in a list. A list is the shape somebody screenshots,
 * and this module ASKS people to take screenshots, so a row-by-row reveal there
 * would put colleagues' numbers into the evidence by default.
 */
export function MaskedNumber({
  value,
  revealable = false,
}: {
  value: string | null
  revealable?: boolean
}) {
  const [revealed, setRevealed] = useState(false)

  if (!value) return <span style={{ color: colors.muted }}>—</span>

  if (!revealable) {
    return (
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: colors.secondary }}>
        {maskWhatsAppNumber(value)}
      </span>
    )
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: colors.primary }}>
        {revealed ? formatWhatsAppNumber(value) : maskWhatsAppNumber(value)}
      </span>
      <button
        type="button"
        onClick={() => setRevealed(v => !v)}
        aria-label={revealed ? 'Hide the number' : 'Show the full number'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '4px',
          padding: '3px 8px', borderRadius: '6px', cursor: 'pointer',
          border: `1px solid ${colors.border}`, background: 'transparent',
          color: colors.tertiary, fontSize: '11px', fontWeight: 600,
        }}
      >
        {revealed ? <EyeOff size={12} strokeWidth={2} /> : <Eye size={12} strokeWidth={2} />}
        {revealed ? 'Hide' : 'Show'}
      </button>
    </span>
  )
}

/**
 * The sentence that keeps "we opened WhatsApp" and "the message was sent"
 * apart, wherever either is displayed.
 */
export function WhatsAppOpenedNote() {
  return (
    <span style={{ color: colors.muted, fontSize: '11px' }}>
      Opening WhatsApp prepares the message. It does not confirm it was sent.
    </span>
  )
}

/**
 * What a screenshot in this module is evidence of, said where it is uploaded
 * and where it is checked.
 *
 * One sentence rather than a panel of guidance: somebody who reads a paragraph
 * on every visit stops reading it by the third day, and the actual safeguards
 * are in the message builder and the database rather than in this box. But this
 * particular sentence earns its place, because "screenshot of a review" is
 * exactly the wrong thing for a verifier to think they are looking at.
 */
export function ScreenshotIsNotProofNote() {
  return (
    <div
      style={{
        display: 'flex', gap: '8px', alignItems: 'flex-start',
        padding: '9px 12px', borderRadius: '8px',
        background: colors.blueTint, border: '1px solid rgba(85,133,232,0.22)',
        fontSize: '12px', lineHeight: 1.5, color: colors.secondary,
      }}
    >
      <span>
        A screenshot here is evidence that the workflow was exercised — nothing more.
        It is not a customer review, not proof that one exists, and not proof of delivery.
      </span>
    </div>
  )
}
