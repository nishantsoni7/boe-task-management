'use client'

import { colors } from '@/lib/tokens'
import { InternalTestWarning, ReviewBadge } from './ReviewPieces'
import { ReadinessBadge, ReviewTypeBadge } from './AssignedReviews'
import { imageReadiness } from '@/lib/customerReviews/reviewTypes'
import {
  TEST_CARD_STATUS_META,
  testCategoryLabel,
  type TestCard,
} from '@/lib/customerReviews/types'

// ── One review, as a card ────────────────────────────────────────────────────
//
// SCANNING ORDER, TOP TO BOTTOM, and it is the order somebody's eye actually
// needs it in:
//
//   badges     type first, then readiness for an image review, then status
//   reference  RW-000031, monospaced, small
//   title      the one line that says what this review is about
//   preview    two lines, truncated
//   footer     the assignee where it matters, and ONE primary action
//
// A WAITING IMAGE REVIEW IS MUTED AND OFFERS NO PRIMARY ACTION. It is not a
// thing anybody can work on yet, and a button that would be refused is worse
// than no button: the card says "Waiting for admin images" and stops there.
//
// ONE ACTION PER CARD. Deletion is a verifier's control and is drawn as a quiet
// ghost at the opposite end of the row, never as a second primary.

/** Two lines of body, cut on a word where possible. */
function preview(body: string, limit = 130): string {
  if (body.length <= limit) return body
  const cut = body.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

export function ReviewCard({
  card,
  actionLabel,
  onAction,
  assigneeName,
  secondary,
}: {
  card: TestCard
  /** The one primary action. Omitted for a review nobody can act on yet. */
  actionLabel?: string
  onAction?: () => void
  /** Shown on the verifier's queues, where whose review it is matters. */
  assigneeName?: string | null
  /** A quiet trailing control, e.g. Delete. Never a second primary. */
  secondary?: React.ReactNode
}) {
  const waiting = imageReadiness(card) === 'awaiting_images'
  const returned = card.status === 'booked' && !!card.returned_at && !!card.sent_confirmed_at

  return (
    <article
      style={{
        display: 'flex', flexDirection: 'column', gap: '9px',
        padding: '13px', borderRadius: '10px', minWidth: 0,
        border: `1px solid ${colors.border}`,
        background: waiting ? colors.raised : '#FFFFFF',
        // A review nobody can start is visibly quieter than one they can.
        opacity: waiting ? 0.82 : 1,
      }}
    >
      {/*
        THE PROVENANCE, ON EVERY CARD. It renders DRAFT_STATUS and nothing a
        caller can reword: the text is a model's draft that a verifier
        approved, and anybody reading one is entitled to know that wherever
        they read it. The page carries no banner version — a status about ONE
        draft, floated above a list of twenty, labels nothing.
      */}
      <InternalTestWarning compact />

      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
        <ReviewTypeBadge type={card.review_type} />
        <ReadinessBadge card={card} />
        {returned && (
          <ReviewBadge meta={{ label: 'Returned', bg: '#FFF7ED', color: '#9A3412', border: '#FED7AA' }} />
        )}
        <ReviewBadge meta={TEST_CARD_STATUS_META[card.status]} />
        <span style={{
          marginLeft: 'auto', fontFamily: 'var(--font-mono)',
          fontSize: '11px', color: colors.tertiary, whiteSpace: 'nowrap',
        }}>
          {card.card_ref}
        </span>
      </div>

      <div>
        <div style={{ fontSize: '11px', color: colors.muted, marginBottom: '3px' }}>
          {testCategoryLabel(card.test_category)}
        </div>
        <h3 style={{
          margin: 0, fontSize: '13.5px', fontWeight: 650, color: colors.primary,
          lineHeight: 1.4, overflowWrap: 'anywhere',
        }}>
          {card.test_title}
        </h3>
      </div>

      <p style={{
        margin: 0, fontSize: '12px', color: colors.secondary,
        lineHeight: 1.55, overflowWrap: 'anywhere',
      }}>
        {preview(card.test_body)}
      </p>

      {assigneeName && (
        <div style={{ fontSize: '11px', color: colors.tertiary }}>
          Assigned to <strong style={{ color: colors.secondary }}>{assigneeName}</strong>
        </div>
      )}

      <div style={{
        display: 'flex', gap: '8px', marginTop: 'auto', paddingTop: '3px',
        alignItems: 'center', flexWrap: 'wrap',
      }}>
        {waiting ? (
          <span style={{ fontSize: '12px', color: '#92400E', fontWeight: 600 }}>
            Waiting for admin images
          </span>
        ) : actionLabel && onAction ? (
          <button
            type="button"
            onClick={onAction}
            className="boe-btn boe-btn-primary"
            style={{ fontSize: '12px', padding: '10px 16px', minHeight: '44px' }}
          >
            {actionLabel} →
          </button>
        ) : null}
        {secondary && <span style={{ marginLeft: 'auto' }}>{secondary}</span>}
      </div>
    </article>
  )
}

/**
 * The grid every list of cards uses.
 *
 * At most two per row, one where there is not room for two. `min(100%, 340px)`
 * is what keeps the single-column case from overflowing a 360px phone: the
 * track can never be wider than the container.
 */
export function ReviewCardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))',
      maxWidth: '900px',
      gap: '12px',
      alignItems: 'start',
    }}>
      {children}
    </div>
  )
}
