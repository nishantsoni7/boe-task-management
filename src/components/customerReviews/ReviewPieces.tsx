'use client'

import { Sparkles } from 'lucide-react'
import { colors } from '@/lib/tokens'
import type { BadgeMeta } from '@/lib/customerReviews/types'
import { DRAFT_STATUS } from '@/lib/customerReviews/internalTest'

// Small pieces shared by the Review Workflow screens. Same visual language as
// MeetingBadge — a status wears one colour in the tab strip, the row and the
// detail header.

/**
 * THE PROVENANCE STATUS, AS A COMPONENT.
 *
 * It renders DRAFT_STATUS and NOTHING ELSE from the caller: no `text` prop, no
 * `children`, no way to reword it. A caller decides WHERE it appears; it cannot
 * decide WHAT it says. That much is unchanged from the label this replaced, and
 * for the same reason — provenance a screen can reword is provenance that
 * eventually says something else.
 *
 * WHAT CHANGED, AND WHY IT MATTERS. This used to be a red INTERNAL TEST ONLY
 * warning that also travelled INSIDE the WhatsApp message. The cards are no
 * longer internal filler, so that wording would now be false. What is still
 * true, and worth a reader knowing, is that the text was drafted by a model and
 * nobody has verified it as a real customer's words — which is what this says.
 *
 * IT IS UI METADATA AND STAYS THERE. It is deliberately NOT in the message
 * body: the recipient receives a draft, not a draft annotated with our internal
 * note about it. buildReviewMessage carries no label at all, and a test asserts
 * that.
 */
export function InternalTestWarning({ compact = false }: { compact?: boolean }) {
  return (
    <div
      role="note"
      aria-label="AI-generated draft"
      style={{
        display: 'flex', gap: compact ? '6px' : '8px', alignItems: 'center',
        padding: compact ? '5px 8px' : '9px 12px',
        borderRadius: compact ? '6px' : '8px',
        background: '#F5F3FF',
        border: '1px solid #DDD6FE',
        color: '#5B21B6',
        fontSize: compact ? '10px' : '12px',
        fontWeight: 700,
        letterSpacing: '0.01em',
        lineHeight: 1.4,
      }}
    >
      <Sparkles size={compact ? 12 : 14} strokeWidth={2.2} style={{ flexShrink: 0 }} />
      <span>{DRAFT_STATUS}</span>
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

/*
 * MaskedNumber USED TO BE HERE, and its removal is part of the correction.
 *
 * It rendered a stored number masked, with a click to reveal the full value for
 * whoever genuinely needed it. Nothing stores a full number now — a card keeps
 * four digits and a non-reversible fingerprint — so there is no full value to
 * reveal, and a component shaped to reveal one is a component somebody would
 * eventually find a number to feed it.
 *
 * What replaced it is maskFromLastFour() in @/lib/customerReviews/contact,
 * which takes the four digits the card actually has.
 */

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
        A screenshot here is evidence that the message was sent — nothing more.
        It is not proof that a review was published, and not proof of delivery.
      </span>
    </div>
  )
}
