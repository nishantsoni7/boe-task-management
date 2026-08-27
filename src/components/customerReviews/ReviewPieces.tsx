'use client'

import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { colors } from '@/lib/tokens'
import type { BadgeMeta } from '@/lib/customerReviews/types'
import { formatWhatsAppNumber, maskWhatsAppNumber } from '@/lib/customerReviews/contact'

// Small pieces shared by the three Customer Review Outreach screens. Same shape
// and the same visual language as MeetingBadge — a status wears one colour in
// the tab strip, the row and the detail header.

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
 * The customer's number, masked, with a deliberate reveal.
 *
 * Masked is the default everywhere, including for the person who typed it. The
 * reveal is a click rather than a hover so it cannot happen by accident while
 * somebody is scrolling past on a shared screen, and it is per-instance state
 * that resets on every navigation — there is no "remember revealed" anywhere.
 *
 * `revealable` is false in the list. A list is the shape somebody screenshots
 * or shares, and a row-by-row reveal there would defeat the point of masking
 * it; the number is one click away on the detail screen for whoever needs it.
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
 * The standing reminder, in one line.
 *
 * It appears on the form and on the detail screen because those are the two
 * places somebody is about to act. It is one sentence rather than a panel of
 * guidance: an employee who reads a paragraph of ethics copy on every visit
 * stops reading it by the third day, and the actual safeguards are in the
 * message builder and the database, not in this box.
 */
export function OutreachPrinciple({ children }: { children?: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex', gap: '8px', alignItems: 'flex-start',
        padding: '9px 12px', borderRadius: '8px', marginBottom: '12px',
        background: colors.blueTint, border: '1px solid rgba(85,133,232,0.22)',
        fontSize: '12px', lineHeight: 1.5, color: colors.secondary,
      }}
    >
      <span>
        {children ?? (
          <>
            Invite only customers you have genuinely worked with. The customer writes and
            publishes the review themselves — positive, neutral or critical is equally
            welcome, and the wording and rating are entirely their choice.
          </>
        )}
      </span>
    </div>
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
