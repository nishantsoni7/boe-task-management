'use client'

import type { ReactNode } from 'react'
import { FileText, Image as ImageIcon } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { ReviewBadge } from './ReviewPieces'
import {
  AWAITING_IMAGES_LABEL,
  CHECKING_IMAGES_LABEL,
  READY_LABEL,
  countReviewsByType,
  imageReadiness,
  progressLine,
  type ReviewCounts,
} from '@/lib/customerReviews/reviewTypes'
import { REVIEW_TYPE_META, type ReviewType, type TestCard } from '@/lib/customerReviews/types'

// ── What a candidate is holding, in two sections and four numbers ────────────
//
// WHY THIS IS NOT A DASHBOARD. There are no charts, no percentages, no
// per-month history and no comparison with anybody else. Four counts and a
// progress line per type, which is what a person needs to answer "how much have
// I done and what is left" — and nothing that would turn a work list into a
// scoreboard.
//
// THE TWO SECTIONS ARE THE POINT. A text review and an image review are
// different work: one is words, the other is words plus photographs of a
// project that somebody has to have prepared. Mixing them in one list means a
// candidate discovers the difference by opening a review and finding a disabled
// button, which is the worst place to learn it.
//
// EVERY NUMBER IS COUNTED FROM ROWS THE CALLER ALREADY HAS, by the same
// functions the verifier's own summary uses. Two screens that computed
// "posted" differently would be two screens that disagree about whether
// somebody has finished.

const PANEL: React.CSSProperties = {
  border: `1px solid ${colors.borderSoft}`,
  borderRadius: '10px',
  background: colors.base,
  padding: '12px 14px',
}

/** One number with its label. Tabular figures so a column of them lines up. */
function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div style={{ minWidth: '84px' }}>
      <div style={{
        fontSize: '20px', fontWeight: 700, lineHeight: 1.1,
        color: tone ?? colors.primary, fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </div>
      <div style={{ fontSize: '11px', color: colors.secondary, marginTop: '2px' }}>{label}</div>
    </div>
  )
}

/**
 * The four operational counts, for one employee's assigned work.
 *
 * ASSIGNED · POSTED · REMAINING · and AVAILABLE, which is the only one that is
 * not simply arithmetic on the other three: remaining is everything not yet
 * handed over (including what is in hand right now), while available is what
 * can be picked up this minute. A candidate looking for "what do I do next"
 * reads Available; somebody asking "am I finished" reads Remaining.
 */
export function AssignedCounts({ counts }: { counts: ReviewCounts }) {
  return (
    <div style={{ ...PANEL, display: 'flex', gap: '18px', flexWrap: 'wrap' }}>
      <Stat label="Assigned" value={counts.assigned} />
      <Stat label="Posted" value={counts.posted} tone="#166534" />
      <Stat label="Remaining" value={counts.remaining} tone={counts.remaining > 0 ? '#92400E' : colors.secondary} />
      <Stat label="Available now" value={counts.available} />
    </div>
  )
}

/**
 * "Text: 3 of 8 posted" — the per-type progress line.
 *
 * Written from the same counts the section renders, so the sentence and the
 * list underneath it can never disagree about how many there are.
 */
export function TypeProgress({ type, counts }: { type: ReviewType; counts: ReviewCounts }) {
  const meta = REVIEW_TYPE_META[type]
  return (
    <span style={{ fontSize: '12px', color: colors.secondary, fontVariantNumeric: 'tabular-nums' }}>
      {meta.label}: {progressLine(counts)}
    </span>
  )
}

/**
 * READINESS, AS A BADGE.
 *
 * Rendered for image reviews and for nothing else — a text review has no
 * project to wait for, so a "Ready" badge on one would be answering a question
 * nobody asked. `groupHasImages` is optional because the list does not always
 * know it; an unknown group is treated as real, and the database refuses the
 * booking if it is not.
 */
export function ReadinessBadge({
  card, groupHasImages, pending,
}: {
  card: Pick<TestCard, 'review_type' | 'image_group_id'>
  groupHasImages?: boolean
  /**
   * The group is being read RIGHT NOW and has not answered yet.
   *
   * Only a surface that actually loads the group passes this. Every other
   * caller shows what the row alone implies, which is all it knows.
   */
  pending?: boolean
}) {
  const readiness = imageReadiness(card, groupHasImages)
  if (readiness === 'not_applicable') return null
  // A review with no group at all is not pending anything — there is nothing
  // to read — so it keeps the definite answer it already has.
  if (pending && card.image_group_id) {
    return <ReviewBadge meta={{ label: CHECKING_IMAGES_LABEL, bg: colors.raised, color: colors.tertiary, border: colors.border }} />
  }
  return readiness === 'ready'
    ? <ReviewBadge meta={{ label: READY_LABEL, bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' }} />
    : <ReviewBadge meta={{ label: AWAITING_IMAGES_LABEL, bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' }} />
}

/** The type badge. Small, and never the same colour as any status. */
export function ReviewTypeBadge({ type }: { type: ReviewType }) {
  return <ReviewBadge meta={REVIEW_TYPE_META[type]} />
}

/**
 * The two sections, each with its own heading, progress line and grid.
 *
 * A SECTION WITH NOTHING IN IT STILL APPEARS, and that is deliberate: "Image
 * reviews — 0 of 4 posted, none available yet" is information, and hiding the
 * heading would leave a candidate who has four image reviews waiting for
 * pictures looking at a screen that says nothing about them at all.
 *
 * `renderCards` is passed in rather than the tile being imported here, because
 * the tile the list screen draws carries that screen's handlers — booking,
 * deleting, opening — and threading five callbacks through this component to
 * reach it would make this file about those handlers instead of about the
 * sections.
 */
export function ReviewTypeSections({
  cards,
  renderCards,
  emptyText,
}: {
  cards: TestCard[]
  renderCards: (subset: TestCard[]) => ReactNode
  /** What a section with no reviews says. Per type, because the reasons differ. */
  emptyText: (type: ReviewType) => string
}) {
  const counts = countReviewsByType(cards)

  const sections: { type: ReviewType; Icon: typeof FileText; rows: TestCard[]; counts: ReviewCounts }[] = [
    { type: 'text',  Icon: FileText,  rows: cards.filter(c => c.review_type !== 'image'), counts: counts.text },
    { type: 'image', Icon: ImageIcon, rows: cards.filter(c => c.review_type === 'image'), counts: counts.image },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <AssignedCounts counts={counts.all} />

      {sections.map(({ type, Icon, rows, counts: c }) => (
        <section key={type} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <header style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <Icon size={15} strokeWidth={2.2} style={{ color: REVIEW_TYPE_META[type].color, flexShrink: 0 }} />
            <h2 style={{
              margin: 0, fontSize: '13px', fontWeight: 700, letterSpacing: '0.04em',
              textTransform: 'uppercase', color: colors.primary,
            }}>
              {REVIEW_TYPE_META[type].plural}
            </h2>
            <TypeProgress type={type} counts={c} />
          </header>

          {rows.length === 0 ? (
            <p style={{
              margin: 0, padding: '14px 16px', borderRadius: '8px', fontSize: '12px',
              border: `1px dashed ${colors.border}`, color: colors.muted, lineHeight: 1.6,
            }}>
              {emptyText(type)}
            </p>
          ) : renderCards(rows)}
        </section>
      ))}
    </div>
  )
}
