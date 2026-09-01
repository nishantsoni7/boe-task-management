'use client'

import { useMemo, useState } from 'react'
import { Loader2, Trash2, TriangleAlert } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { ReviewSheet } from './ReviewSheet'
import {
  deletionSeverity,
  deletionWarning,
  type DeletionSeverity,
} from '@/lib/customerReviews/status'
import {
  TEST_CARD_STATUS_META,
  type DeletionSummary,
  type TestCard,
} from '@/lib/customerReviews/types'

// ── Deleting reviews ─────────────────────────────────────────────────────────
//
// THREE SCOPES, ONE IDEA: a verifier can take a review out of the workflow at
// any stage it has reached, and the interface's job is to make sure they know
// what stage that is BEFORE they do it.
//
//   one review      from an overflow action on its own row or page
//   a selection     from the batch toolbar, alongside Approve selected
//   everything      from one clearly separated control
//
// DELETION IS NOT DESTRUCTION HERE. A deleted review keeps its tombstone, its
// audit trail and its screenshot; what it loses is its place in the workflow.
// The sheets say so, because "permanently deleted" would be a promise the
// module does not keep and does not want to.
//
// THESE COMPONENTS DECIDE NOTHING. They render a confirmation and call back.
// Authority is resolved three times over — the screen renders them only for
// caps.canVerify, the RPC resolves `verify` from the permission engine, and the
// database function resolves it again under a row lock and is what refuses.
//
// WHY THE WORDING GETS HEAVIER RATHER THAN THE ACTION GETTING BLOCKED. The
// requirement is that a verifier may delete a review in ANY stage, so the
// database allows all of them. A booked or sent review is somebody else's work
// in progress, and the only honest place to put that fact is in front of the
// person about to discard it.

/** Danger styling, in one place so every destructive control matches. */
const DANGER = {
  bg: '#FEF2F2',
  border: '#FECACA',
  color: '#B91C1C',
} as const

const dangerButton = {
  background: DANGER.color,
  border: `1px solid ${DANGER.color}`,
  color: '#FFFFFF',
  fontSize: '13px',
  padding: '11px 16px',
  minHeight: '44px',
  borderRadius: '8px',
  fontFamily: 'inherit',
  fontWeight: 600,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '7px',
} as const

/**
 * The secondary, low-emphasis Delete control that sits beside a review.
 *
 * DELIBERATELY NOT A PRIMARY BUTTON. It shares a row with the actions a
 * verifier actually uses all day, and the one that throws work away should not
 * be the one their thumb lands on. It is text-weight with a danger colour, 44px
 * tall like everything else, and it opens a sheet rather than acting.
 */
export function DeleteReviewButton({
  onClick,
  disabled,
  label = 'Delete',
  compact = false,
}: {
  onClick: () => void
  disabled?: boolean
  label?: string
  compact?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="boe-btn boe-btn-ghost"
      style={{
        fontSize: compact ? '12px' : '13px',
        padding: compact ? '9px 12px' : '11px 14px',
        minHeight: '44px',
        color: DANGER.color,
        borderColor: DANGER.border,
      }}
    >
      <Trash2 size={13} strokeWidth={2} />
      {label}
    </button>
  )
}

/**
 * The confirmation for one review or a selection.
 *
 * WHAT IT HAS TO SHOW, AND DOES:
 *   * the reference and title of what is going, so the verifier can check they
 *     picked the right thing;
 *   * the STAGE each one has reached, as a badge — not a word buried in prose;
 *   * a heavier warning when any of them is held or sent, naming the person's
 *     work rather than the state;
 *   * the plain fact that it disappears from the candidate's workflow.
 *
 * ONE TAP DOES NOT DELETE. This sheet is always in the way, for a single review
 * as much as for a selection.
 */
export function DeleteReviewsSheet({
  cards,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  /** What is about to be deleted. One entry for a single delete. */
  cards: TestCard[]
  busy: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const n = cards.length

  // The worst stage in the set decides the wording, because a selection is only
  // as safe as the most advanced review in it.
  const severity: DeletionSeverity = useMemo(() => {
    const all = cards.map(deletionSeverity)
    if (all.includes('sent')) return 'sent'
    if (all.includes('held')) return 'held'
    return 'unstarted'
  }, [cards])

  const heavy = severity !== 'unstarted'

  return (
    <ReviewSheet
      title={n === 1 ? 'Delete this review?' : `Delete ${n} reviews?`}
      subtitle={n === 1 ? cards[0]?.card_ref : 'The whole selection, or none of it'}
      maxWidth="520px"
      onClose={() => { if (!busy) onCancel() }}
      footer={
        <>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            style={{ ...dangerButton, flex: '1 1 auto', opacity: busy ? 0.7 : 1 }}
          >
            {busy && <Loader2 size={14} strokeWidth={2.4} style={{ animation: 'boe-spin 0.8s linear infinite' }} />}
            {busy ? 'Deleting…' : n === 1 ? 'Yes, delete it' : `Yes, delete ${n}`}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="boe-btn boe-btn-ghost"
            style={{ justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
          >
            Cancel
          </button>
        </>
      }
    >
      {heavy && (
        <div
          role="alert"
          style={{
            display: 'flex', gap: '9px', alignItems: 'flex-start',
            padding: '11px 12px', borderRadius: '9px',
            background: DANGER.bg, border: `1px solid ${DANGER.border}`,
          }}
        >
          <TriangleAlert size={15} strokeWidth={2.2} style={{ color: DANGER.color, flexShrink: 0, marginTop: '1px' }} />
          <p style={{ margin: 0, fontSize: '12.5px', color: DANGER.color, lineHeight: 1.55 }}>
            {severity === 'sent'
              ? (n === 1
                  ? 'This review has already been sent to a real recipient, or its evidence is in verification. Deleting it does not unsend anything — it removes the review from the module.'
                  : 'At least one of these has already been sent to a real recipient, or its evidence is in verification. Deleting them does not unsend anything.')
              : (n === 1
                  ? 'A candidate is holding this review right now. It will disappear from their workflow and they will not be able to finish it.'
                  : 'At least one of these is being held by a candidate right now. It will disappear from their workflow without warning.')}
          </p>
        </div>
      )}

      {/* WHAT IS GOING, LISTED. Capped so a selection of eight cannot push the
          confirm button off a phone screen; the count above is always exact. */}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '7px' }}>
        {cards.slice(0, 6).map(card => (
          <li
            key={card.id}
            style={{
              display: 'flex', gap: '9px', alignItems: 'flex-start',
              padding: '9px 10px', borderRadius: '8px',
              border: `1px solid ${colors.border}`, background: colors.raised,
              minWidth: 0,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: colors.tertiary }}>
                {card.card_ref}
              </div>
              <div style={{
                fontSize: '12.5px', color: colors.primary, fontWeight: 600,
                lineHeight: 1.4, overflowWrap: 'anywhere',
              }}>
                {card.test_title}
              </div>
              {deletionWarning(card) && (
                <div style={{ fontSize: '11px', color: DANGER.color, lineHeight: 1.45, marginTop: '3px' }}>
                  {deletionWarning(card)}
                </div>
              )}
            </div>
            <StageBadge card={card} />
          </li>
        ))}
        {cards.length > 6 && (
          <li style={{ fontSize: '11.5px', color: colors.muted, paddingLeft: '2px' }}>
            …and {cards.length - 6} more.
          </li>
        )}
      </ul>

      <p style={{ margin: 0, fontSize: '12px', color: colors.secondary, lineHeight: 1.6 }}>
        {/*
          {' '} RATHER THAN A PLAIN SPACE, and it is load-bearing here.
          A JSX text node that contains an HTML entity loses its LEADING space
          when it follows an inline expression (Next 16.2.6) — this paragraph
          rendered as "It disappearsfrom every list" until the space was made
          explicit. The entity two lines down is what triggers it.
        */}
        {n === 1 ? 'It disappears' : 'They disappear'}{' '}
        from every list and from any
        candidate&rsquo;s workflow immediately, and can no longer be booked, sent or
        verified. The audit trail and any attached screenshot are kept, and this
        cannot be undone from the app.
      </p>

      {n > 1 && (
        <p style={{ margin: 0, fontSize: '11.5px', color: colors.tertiary, lineHeight: 1.55 }}>
          All {n} are deleted together, or none of them are — if one has already gone,
          nothing changes and you can try again against a refreshed list.
        </p>
      )}

      {error && (
        <p role="alert" style={{ margin: 0, fontSize: '12px', color: colors.red, lineHeight: 1.55 }}>
          {error}
        </p>
      )}
    </ReviewSheet>
  )
}

/** The stage a review has reached, as the badge used everywhere else. */
function StageBadge({ card }: { card: Pick<TestCard, 'status' | 'sent_confirmed_at'> }) {
  const meta = TEST_CARD_STATUS_META[card.status]
  // "Sent" is status booked plus a timestamp, which is the module's idiom
  // throughout. A verifier deciding whether to delete needs to see it as its
  // own thing, because it is the one stage that reached a real person.
  const label = card.status === 'booked' && card.sent_confirmed_at ? 'Sent' : meta.label
  return (
    <span style={{
      flexShrink: 0, fontSize: '10.5px', fontWeight: 600, whiteSpace: 'nowrap',
      padding: '3px 8px', borderRadius: '999px',
      background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`,
    }}>
      {label}
    </span>
  )
}

/** What the verifier must type to delete everything. */
export const DELETE_ALL_PHRASE = 'DELETE ALL'

/**
 * Deleting every review in the module.
 *
 * FOUR THINGS MAKE THIS HARDER TO DO BY ACCIDENT THAN ANYTHING ELSE HERE:
 *
 *   1. THE COUNTS ARE RE-READ from the database when the sheet opens, not taken
 *      from the list on screen. No tab reads `verified` rows by design, so a
 *      browser-side total would quietly leave some of "everything" out.
 *   2. THEY ARE BROKEN DOWN BY STAGE, so "6 available" and "3 booked, 1 sent"
 *      are separate facts rather than a total of ten.
 *   3. A TYPED PHRASE, not a second tap. The confirm button cannot be reached
 *      by muscle memory.
 *   4. The button is separated from generation and approval on the screen
 *      itself, so it is never the neighbour of a control used routinely.
 *
 * THE NUMBER IS NOT A PROMISE. Between reading it and pressing the button
 * somebody can book a review; the database chooses and locks the set inside the
 * transaction and returns what it actually deleted, which is what the screen
 * reports afterwards.
 */
export function DeleteAllReviewsSheet({
  summary,
  loadingSummary,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  /** Null while it is being read, which is what disables the action. */
  summary: DeletionSummary | null
  loadingSummary: boolean
  busy: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const [typed, setTyped] = useState('')

  // THE PHRASE IS CLEARED THE MOMENT IT IS USED, so a refusal — and every
  // refusal here is the database saying something changed — leaves the button
  // disarmed rather than one tap from firing again.
  //
  // There is no effect resetting this, deliberately. The parent unmounts the
  // sheet on cancel and on success, so a fresh sheet starts empty by
  // construction; an effect that called setState to re-establish that would be
  // a cascading render doing work `useState('')` already does.
  const confirmAndDisarm = () => { setTyped(''); onConfirm() }

  const armed = typed.trim().toUpperCase() === DELETE_ALL_PHRASE
  const total = summary?.total ?? 0
  const nothing = !loadingSummary && total === 0

  const rows: { label: string; value: number; heavy?: boolean }[] = summary
    ? [
        { label: 'Awaiting approval', value: summary.pending_approval },
        { label: 'Available to book', value: summary.available },
        { label: 'Booked, not yet sent', value: summary.booked, heavy: true },
        { label: 'Sent to a recipient', value: summary.sent, heavy: true },
        { label: 'Submitted for verification', value: summary.submitted, heavy: true },
        { label: 'Verified', value: summary.verified, heavy: true },
      ].filter(r => r.value > 0)
    : []

  const inFlight = (summary?.booked ?? 0) + (summary?.sent ?? 0) + (summary?.submitted ?? 0)

  return (
    <ReviewSheet
      title="Delete every review?"
      subtitle="Including reviews candidates are working on right now"
      maxWidth="520px"
      onClose={() => { if (!busy) onCancel() }}
      footer={
        <>
          <button
            type="button"
            onClick={confirmAndDisarm}
            disabled={busy || !armed || nothing || loadingSummary}
            style={{
              ...dangerButton,
              flex: '1 1 auto',
              opacity: busy || !armed || nothing || loadingSummary ? 0.5 : 1,
              cursor: busy || !armed || nothing || loadingSummary ? 'not-allowed' : 'pointer',
            }}
          >
            {busy && <Loader2 size={14} strokeWidth={2.4} style={{ animation: 'boe-spin 0.8s linear infinite' }} />}
            {busy ? 'Deleting…' : total > 0 ? `Delete all ${total}` : 'Delete all'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="boe-btn boe-btn-ghost"
            style={{ justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
          >
            Cancel
          </button>
        </>
      }
    >
      {loadingSummary ? (
        <p style={{ margin: 0, fontSize: '13px', color: colors.muted }}>
          Counting what is there…
        </p>
      ) : nothing ? (
        <p style={{ margin: 0, fontSize: '13px', color: colors.secondary, lineHeight: 1.6 }}>
          There are no reviews left to delete.
        </p>
      ) : (
        <>
          <div style={{
            border: `1px solid ${colors.border}`, borderRadius: '9px', overflow: 'hidden',
          }}>
            {rows.map((r, i) => (
              <div
                key={r.label}
                style={{
                  display: 'flex', justifyContent: 'space-between', gap: '12px',
                  padding: '9px 12px', fontSize: '12.5px',
                  borderTop: i === 0 ? 'none' : `1px solid ${colors.border}`,
                  background: r.heavy ? DANGER.bg : colors.raised,
                  color: r.heavy ? DANGER.color : colors.secondary,
                }}
              >
                <span>{r.label}</span>
                <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{r.value}</strong>
              </div>
            ))}
            <div style={{
              display: 'flex', justifyContent: 'space-between', gap: '12px',
              padding: '10px 12px', fontSize: '13px', fontWeight: 700,
              borderTop: `1px solid ${colors.border}`, background: '#FFFFFF',
              color: colors.primary,
            }}>
              <span>Total</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{total}</span>
            </div>
          </div>

          {inFlight > 0 && (
            <div
              role="alert"
              style={{
                display: 'flex', gap: '9px', alignItems: 'flex-start',
                padding: '11px 12px', borderRadius: '9px',
                background: DANGER.bg, border: `1px solid ${DANGER.border}`,
              }}
            >
              <TriangleAlert size={15} strokeWidth={2.2} style={{ color: DANGER.color, flexShrink: 0, marginTop: '1px' }} />
              <p style={{ margin: 0, fontSize: '12.5px', color: DANGER.color, lineHeight: 1.55 }}>
                {inFlight === 1
                  ? '1 of these is work a candidate has started.'
                  : `${inFlight} of these are work candidates have started.`}{' '}
                They disappear from those people&rsquo;s screens without warning, and
                anything already sent stays sent.
              </p>
            </div>
          )}

          <p style={{ margin: 0, fontSize: '12px', color: colors.secondary, lineHeight: 1.6 }}>
            Every review leaves the module. Audit trails and attached screenshots are
            kept, and this cannot be undone from the app.
          </p>

          <label style={{
            display: 'flex', flexDirection: 'column', gap: '6px',
            fontSize: '12px', color: colors.secondary,
          }}>
            Type <strong style={{ fontFamily: 'var(--font-mono)' }}>{DELETE_ALL_PHRASE}</strong> to confirm
            <input
              type="text"
              value={typed}
              onChange={e => setTyped(e.target.value)}
              disabled={busy}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              aria-label={`Type ${DELETE_ALL_PHRASE} to confirm deleting every review`}
              className="boe-input"
              style={{ minHeight: '44px', fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}
            />
          </label>
        </>
      )}

      {error && (
        <p role="alert" style={{ margin: 0, fontSize: '12px', color: colors.red, lineHeight: 1.55 }}>
          {error}
        </p>
      )}
    </ReviewSheet>
  )
}

/**
 * The entry point for Delete all, kept away from everything else.
 *
 * A full-width row of its own with a rule above it, below the list rather than
 * beside the generate and approve controls — so nothing a verifier presses
 * routinely shares an edge with it.
 */
export function DeleteAllReviewsBar({
  onOpen,
  disabled,
}: {
  onOpen: () => void
  disabled?: boolean
}) {
  return (
    <div style={{
      marginTop: '10px', paddingTop: '14px',
      borderTop: `1px solid ${colors.border}`,
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px',
    }}>
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <div style={{ fontSize: '12.5px', fontWeight: 600, color: colors.primary }}>
          Clear the module
        </div>
        <p style={{ margin: '2px 0 0', fontSize: '11.5px', color: colors.muted, lineHeight: 1.5 }}>
          Deletes every review in every stage, including ones candidates are holding.
        </p>
      </div>
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        className="boe-btn boe-btn-ghost"
        style={{
          fontSize: '12.5px', padding: '11px 16px', minHeight: '44px',
          color: DANGER.color, borderColor: DANGER.border,
        }}
      >
        <Trash2 size={14} strokeWidth={2} />
        Delete all reviews
      </button>
    </div>
  )
}
