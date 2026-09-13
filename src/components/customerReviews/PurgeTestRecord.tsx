'use client'

import { useCallback, useRef, useState } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { ReviewSheet } from './ReviewSheet'
import { DeleteReviewButton } from './DeleteReviews'
import { formatTestTimestamp, type TestCard } from '@/lib/customerReviews/types'
import type { PurgeRecord } from '@/lib/customerReviews/testCardPurge'

// ── Permanently deleting an internal test record ─────────────────────────────
//
// NOT THE VERIFIER'S DELETE. That one keeps the record, its trail and its files
// as a tombstone. This one erases all three, so it is kept apart from it: its
// own section at the foot of the page, its own wording, its own confirmation.
//
// THE PARENT DRAWS THIS ONLY WHEN the database says the viewer may purge and
// the card may still be purged. Neither is the decision — the route and the
// database functions re-check both.

const DANGER = { bg: '#FEF2F2', border: '#FECACA', color: '#B91C1C' } as const

export const PURGE_DELETE_LABEL = 'Permanently delete test record'
export const PURGE_CONTINUE_LABEL = 'Continue permanent deletion'
export const PURGE_IN_PROGRESS_HEADING = 'Permanent deletion in progress'

export function PurgeTestRecord({
  card,
  fileCount,
  eventCount,
  resume = false,
  onPurged,
}: {
  card: Pick<TestCard, 'id' | 'card_ref' | 'test_title'>
  /** Screenshots and review images currently attached. */
  fileCount: number
  /** Entries in the activity history. */
  eventCount: number
  /**
   * The purge already started and did not finish. Continuing runs exactly the
   * same request — the route resumes a started purge rather than starting a
   * second one — so only the wording changes.
   */
  resume?: boolean
  onPurged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const acting = useRef(false)

  const purge = useCallback(async () => {
    if (acting.current) return
    acting.current = true
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/customer-reviews/test-cards/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: card.id }),
      })
      if (!response.ok) {
        // THE SHEET STAYS OPEN. A storage failure is resumable, and trying again
        // from here is exactly how it resumes.
        const payload = await response.json().catch(() => null)
        setError(typeof payload?.error === 'string'
          ? payload.error
          : 'The test record could not be permanently deleted. Try again.')
        return
      }
      setOpen(false)
      onPurged()
    } catch {
      setError('The test record could not be permanently deleted. Check your connection and try again.')
    } finally {
      acting.current = false
      setBusy(false)
    }
  }, [card.id, onPurged])

  return (
    <>
      <section style={{
        padding: '14px', borderRadius: '10px',
        border: `1px dashed ${resume ? DANGER.border : colors.border}`, background: resume ? DANGER.bg : colors.raised,
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px',
      }}>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <h2 style={{
            margin: 0, fontSize: '12px', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '0.05em', color: resume ? DANGER.color : colors.tertiary,
          }}>
            {resume ? PURGE_IN_PROGRESS_HEADING : 'Test data'}
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: '11.5px', color: colors.muted, lineHeight: 1.5 }}>
            {resume
              ? 'Permanent deletion of this record started but did not finish. Continue it to remove the remaining files and the record.'
              : 'This draft has never left internal review. An administrator can remove it entirely.'}
          </p>
        </div>
        <DeleteReviewButton
          compact
          label={resume ? PURGE_CONTINUE_LABEL : PURGE_DELETE_LABEL}
          disabled={busy}
          onClick={() => { setError(null); setOpen(true) }}
        />
      </section>

      {open && (
        <ReviewSheet
          title={resume ? `${PURGE_CONTINUE_LABEL}?` : `${PURGE_DELETE_LABEL}?`}
          subtitle={card.card_ref}
          maxWidth="520px"
          onClose={() => { if (!busy) setOpen(false) }}
          footer={
            <>
              <button
                type="button"
                onClick={() => { void purge() }}
                disabled={busy}
                style={{
                  flex: '1 1 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
                  background: DANGER.color, border: `1px solid ${DANGER.color}`, color: '#FFFFFF',
                  fontSize: '13px', fontWeight: 600, fontFamily: 'inherit',
                  padding: '11px 16px', minHeight: '44px', borderRadius: '8px',
                  cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.7 : 1,
                }}
              >
                {busy && <Loader2 size={14} strokeWidth={2.4} style={{ animation: 'boe-spin 0.8s linear infinite' }} />}
                {busy ? 'Deleting…' : resume ? 'Continue deletion' : 'Delete permanently'}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="boe-btn boe-btn-ghost"
                style={{ justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
              >
                Cancel
              </button>
            </>
          }
        >
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
              This action cannot be undone.
            </p>
          </div>

          <p style={{ margin: 0, fontSize: '13px', color: colors.secondary, lineHeight: 1.6 }}>
            This permanently removes the internal test record{' '}
            <strong style={{ color: colors.primary }}>{card.card_ref}</strong>
            {' '}({card.test_title}).
          </p>

          <p style={{ margin: 0, fontSize: '12px', color: colors.secondary, lineHeight: 1.6 }}>
            Screenshots and activity history will also be removed
            {' '}({fileCount === 1 ? '1 stored file' : `${fileCount} stored files`},
            {' '}{eventCount === 1 ? '1 history entry' : `${eventCount} history entries`}).
            Nothing is kept as a tombstone.
          </p>

          <p style={{ margin: 0, fontSize: '11.5px', color: colors.tertiary, lineHeight: 1.55 }}>
            Only a draft that was never approved, assigned, booked, shared or submitted can be
            removed this way. A review with BOE Credits attached is refused.
          </p>

          {error && (
            <p role="alert" style={{ margin: 0, fontSize: '12px', color: colors.red, lineHeight: 1.55 }}>
              {error}
            </p>
          )}
        </ReviewSheet>
      )}
    </>
  )
}

/**
 * The purge page: one card, read-only, and the purge.
 *
 * TestCardDetailScreen shows it in place of the review in two cases only, both
 * decided by the database (the record exists only for somebody it lets purge,
 * only while the card may still be purged):
 *
 *   * a purge that started and did not finish, reopened after a reload — the
 *     card is frozen, and continuing is the only thing left to do with it;
 *   * a viewer who does not hold `verify` — they get the record and the purge,
 *     never a review action.
 *
 * NOTHING HERE ACTS ON THE REVIEW. There is no approval, verification, booking,
 * sharing, attachment or verifier Delete — only the one purge control.
 */
export function PurgeRecordView({
  record,
  onPurged,
}: {
  record: PurgeRecord
  onPurged: () => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '760px' }}>
      {record.purgeInProgress && (
        <div
          role="status"
          style={{
            padding: '10px 12px', borderRadius: '8px',
            background: DANGER.bg, border: `1px solid ${DANGER.border}`,
            fontSize: '12.5px', color: DANGER.color, lineHeight: 1.55,
          }}
        >
          <strong>{PURGE_IN_PROGRESS_HEADING}.</strong>{' '}
          This record was frozen when its deletion started, so it can no longer be approved,
          edited or used. Continue the deletion below to finish removing it.
        </div>
      )}

      <PurgeSection title="Record">
        <dl style={{ margin: 0, display: 'grid', gap: '6px' }}>
          <PurgeFact label="Reference" value={record.cardRef} />
          <PurgeFact label="Title" value={record.testTitle} />
          <PurgeFact
            label="Status"
            value={record.purgeInProgress ? PURGE_IN_PROGRESS_HEADING : 'Draft awaiting approval, never approved'}
          />
          <PurgeFact label="Type" value={record.reviewType === 'image' ? 'Image review' : 'Text review'} />
          <PurgeFact label="Created" value={formatTestTimestamp(record.createdAt)} />
        </dl>
        <p style={{
          margin: '10px 0 0', fontSize: '13px', color: colors.primary,
          lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        }}>
          {record.testBody}
        </p>
      </PurgeSection>

      <PurgeSection title="Stored files">
        {record.attachments.length === 0 ? (
          <p style={{ margin: 0, fontSize: '12px', color: colors.muted }}>No file is attached.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: '18px', display: 'grid', gap: '4px', fontSize: '12px', color: colors.secondary }}>
            {record.attachments.map((file, i) => (
              <li key={`${file.fileName}-${i}`} style={{ overflowWrap: 'anywhere' }}>
                {file.fileName} ({file.kind === 'review_image' ? 'review image' : file.kind})
              </li>
            ))}
          </ul>
        )}
      </PurgeSection>

      <PurgeSection title="Activity">
        {record.events.length === 0 ? (
          <p style={{ margin: 0, fontSize: '12px', color: colors.muted }}>Nothing recorded.</p>
        ) : (
          <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '8px' }}>
            {record.events.map((event, i) => (
              <li key={`${event.createdAt}-${i}`} style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.55 }}>
                <span style={{ color: colors.muted, marginRight: '8px', fontVariantNumeric: 'tabular-nums' }}>
                  {formatTestTimestamp(event.createdAt)}
                </span>
                <strong style={{ color: colors.primary }}>{event.eventType.replace(/_/g, ' ')}</strong>
                {event.detail && <span> — {event.detail}</span>}
              </li>
            ))}
          </ol>
        )}
      </PurgeSection>

      <PurgeTestRecord
        card={{ id: record.id, card_ref: record.cardRef, test_title: record.testTitle }}
        fileCount={record.attachments.length}
        eventCount={record.events.length}
        resume={record.purgeInProgress}
        onPurged={onPurged}
      />
    </div>
  )
}

function PurgeSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{
      padding: '14px', borderRadius: '10px',
      border: `1px solid ${colors.border}`, background: colors.raised,
    }}>
      <h2 style={{
        margin: '0 0 10px', fontSize: '12px', fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.05em', color: colors.tertiary,
      }}>
        {title}
      </h2>
      {children}
    </section>
  )
}

function PurgeFact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', fontSize: '12px' }}>
      <dt style={{ color: colors.muted, minWidth: '120px' }}>{label}</dt>
      <dd style={{ margin: 0, color: colors.secondary, overflowWrap: 'anywhere' }}>{value}</dd>
    </div>
  )
}
