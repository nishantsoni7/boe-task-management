'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { Check, Copy, Loader2 } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { InternalTestWarning, ReviewBadge } from './ReviewPieces'
import { buildReviewMessage } from '@/lib/customerReviews/internalTest'
import {
  TEST_CARD_STATUS_META,
  formatTestDate,
  testCategoryLabel,
  type TestCard,
} from '@/lib/customerReviews/types'

// ── The complete review, and the only place a candidate can book one ─────────
//
// WHY BOOKING MOVED OFF THE CARD. A tile shows a truncated preview, so booking
// from a tile meant taking a review on the strength of its first line and a
// half. The product rule is that a candidate reads the whole thing first, and
// the way to make a UI path required is to put the action only at the end of it
// — so `Book` exists HERE and on no card, no row and no list.
//
// THIS IS A UI PATH, NOT A GUARANTEE, AND IT IS NOT ASKED TO BE ONE. Nothing
// here reports "the candidate has read it", and nothing downstream believes
// such a flag: book_customer_review_test_card() claims the row with a
// conditional UPDATE against status = 'available' and would refuse a stale,
// double or unauthorised booking whatever this component sent. A browser flag
// claiming somebody read something is not evidence, so no such flag is
// invented.
//
// WHAT IT SHOWS, IN THE ORDER SOMEBODY NEEDS IT:
//   the provenance note, the reference and status, the complete title, the
//   complete body, THE EXACT TEXT WHATSAPP WILL BE HANDED, and then the action.
//
// THE MESSAGE IS BUILT BY buildReviewMessage AND NOTHING ELSE, which is the
// same single builder the server uses to compose the wa.me link. That is what
// makes "the exact outgoing message" true rather than approximately true: a
// parity test decodes the URL the server returns and compares it to this call.
// It carries the draft and nothing else — no label, no reference, no category —
// because the recipient receives a suggested review, not a suggested review
// annotated with our internal notes about it.
//
// IT DOES NOT SEND ANYTHING, and it does not offer to. The WhatsApp control
// lives on the card screen, after booking, behind a number and a confirmation.

export function ReviewFullView({
  card,
  canBook,
  bookError,
}: {
  card: TestCard
  /** Only to explain its absence — the control itself is in the sheet footer. */
  canBook: boolean
  /** Kept visible inside the view, so a failure does not throw the reader out. */
  bookError: string | null
}) {
  const message = useMemo(() => buildReviewMessage({
    title: card.test_title,
    body: card.test_body,
    categoryLabel: testCategoryLabel(card.test_category),
    reference: card.card_ref,
  }), [card.test_title, card.test_body, card.test_category, card.card_ref])

  /**
   * Whether the outgoing message is the body character for character.
   *
   * It usually is — buildReviewMessage carries the draft and nothing else — and
   * it stops being so the moment a body holds a line break or a double space,
   * because the builder collapses runs of whitespace. Compared rather than
   * assumed, so the view tells the truth in both cases without anybody having
   * to remember which one is current.
   */
  const identical = message === card.test_body.trim()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <InternalTestWarning />

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <ReviewBadge meta={TEST_CARD_STATUS_META[card.status]} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: colors.tertiary }}>
          {card.card_ref}
        </span>
        <span style={{ fontSize: '11px', color: colors.muted }}>
          {testCategoryLabel(card.test_category)}
        </span>
        {card.approved_at && (
          <span style={{ fontSize: '11px', color: colors.muted }}>
            Approved {formatTestDate(card.approved_at)}
          </span>
        )}
      </div>

      <div>
        <h3 style={{
          margin: 0, fontSize: '15px', fontWeight: 700, color: colors.primary,
          lineHeight: 1.4, overflowWrap: 'anywhere',
        }}>
          {card.test_title}
        </h3>
      </div>

      {/*
        ONE RENDERING WHEN THERE IS ONE TEXT, TWO WHEN THERE ARE TWO.
        buildReviewMessage carries the draft and nothing else, so the outgoing
        message is USUALLY the body character for character — and the first
        version of this view printed the same six hundred characters twice,
        under two headings, which on a phone was a whole extra screen of
        scrolling that told the reader nothing.
        It can still differ: the builder collapses runs of whitespace, so a body
        with line breaks or double spaces produces a message that is not
        identical to it. When that happens BOTH are shown, because the candidate
        is entitled to see the text that will actually be sent rather than the
        text it was made from. When it does not happen, the heading says the two
        are the same instead of proving it by repetition.
      */}
      <Block label={identical ? 'The full review, and the exact message' : 'The full review'}>
        {identical ? (
          <>
            <pre
              data-testid="review-outgoing-message"
              style={{
                margin: 0, fontSize: '13px', color: colors.primary, lineHeight: 1.65,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                fontFamily: 'inherit', background: 'transparent', border: 'none', padding: 0,
              }}
            >
              {message}
            </pre>
            <p style={{ margin: '9px 0 0', fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>
              This is exactly what WhatsApp will be handed and exactly what the recipient
              would see — the review and nothing else. You choose the number and press send
              yourself in WhatsApp; BOE never sends a message for you.
            </p>
          </>
        ) : (
          <p style={{
            margin: 0, fontSize: '13px', color: colors.primary, lineHeight: 1.65,
            whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
          }}>
            {card.test_body}
          </p>
        )}
        <div style={{ marginTop: '11px' }}>
          <CopyMessageButton message={message} />
        </div>
      </Block>

      {!identical && (
        <Block label="What WhatsApp will be handed">
          <pre
            data-testid="review-outgoing-message"
            style={{
              margin: 0, padding: '11px 12px', borderRadius: '8px',
              background: '#F9FAFB', border: `1px solid ${colors.border}`,
              fontSize: '12px', lineHeight: 1.6, whiteSpace: 'pre-wrap',
              wordBreak: 'break-word', fontFamily: 'inherit', color: colors.primary,
            }}
          >
            {message}
          </pre>
          <p style={{ margin: '9px 0 0', fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>
            The spacing above is normalised, so this differs slightly from the review as
            stored. This is the version that goes out — the review and nothing else. You
            choose the number and press send yourself; BOE never sends a message for you.
          </p>
        </Block>
      )}

      {bookError && (
        <p role="alert" style={{ margin: 0, fontSize: '12px', color: colors.red, lineHeight: 1.5 }}>
          {bookError}
        </p>
      )}

      {!canBook && card.status === 'available' && (
        <p style={{ margin: 0, fontSize: '12px', color: colors.tertiary, lineHeight: 1.55 }}>
          You can read this review, but booking one needs the Use permission for this module.
        </p>
      )}
    </div>
  )
}

/**
 * The Book control, kept out of the body above so the sheet can pin it to the
 * bottom. On a phone the review is longer than the screen, and an action you
 * have to scroll past a paragraph to reach is an action people miss.
 */
export function ReviewFullViewActions({
  canBook,
  booking,
  onBook,
  onClose,
}: {
  canBook: boolean
  booking: boolean
  onBook: () => void
  onClose: () => void
}) {
  return (
    <>
      {canBook && (
        <button
          type="button"
          onClick={onBook}
          // Disabled WHILE THE REQUEST IS IN FLIGHT, so a second tap cannot
          // start a second booking. The ref guard in the caller stops one that
          // lands in the same tick, and the database's conditional UPDATE is
          // what actually decides.
          disabled={booking}
          className="boe-btn boe-btn-primary"
          style={{
            flex: '1 1 auto', justifyContent: 'center',
            fontSize: '13px', padding: '11px 18px', minHeight: '44px',
          }}
        >
          {booking && <Loader2 size={14} strokeWidth={2.4} style={{ animation: 'boe-spin 0.8s linear infinite' }} />}
          {booking ? 'Booking…' : 'Book this review'}
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        disabled={booking}
        className="boe-btn boe-btn-ghost"
        style={{
          flex: canBook ? '0 0 auto' : '1 1 auto', justifyContent: 'center',
          fontSize: '13px', padding: '11px 18px', minHeight: '44px',
        }}
      >
        Close
      </button>
    </>
  )
}

/**
 * Copy, with an answer either way.
 *
 * navigator.clipboard is unavailable on an insecure origin and can be refused
 * by permission policy, and both cases arrive as a rejected promise rather than
 * an exception — a button that ignores it says "Copied" while the clipboard
 * still holds whatever it held before. The failure state names the alternative
 * (select the text above) rather than only reporting that something went wrong.
 */
function CopyMessageButton({ message }: { message: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const copy = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('unavailable')
      await navigator.clipboard.writeText(message)
      setState('copied')
    } catch {
      setState('failed')
    }
    timer.current = setTimeout(() => setState('idle'), 2500)
  }, [message])

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '9px', flexWrap: 'wrap' }}>
      <button
        type="button"
        onClick={copy}
        className="boe-btn boe-btn-ghost"
        style={{ fontSize: '12px', padding: '9px 14px', minHeight: '44px' }}
      >
        {state === 'copied'
          ? <Check size={13} strokeWidth={2.4} />
          : <Copy size={13} strokeWidth={2} />}
        {state === 'copied' ? 'Copied' : 'Copy message'}
      </button>
      {/*
        role="status" so the outcome is announced rather than only shown, and
        rendered as text rather than as a colour — a green tick alone tells a
        colour-blind reader nothing.
      */}
      <span role="status" style={{
        fontSize: '11px', lineHeight: 1.4,
        color: state === 'failed' ? colors.red : state === 'copied' ? '#166534' : 'transparent',
      }}>
        {state === 'copied' ? 'The message is on your clipboard.'
          : state === 'failed' ? 'Could not reach the clipboard — select the text above and copy it.'
          : ' '}
      </span>
    </div>
  )
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 style={{
        margin: '0 0 7px', fontSize: '11px', fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.05em', color: colors.tertiary,
      }}>
        {label}
      </h4>
      {children}
    </section>
  )
}
