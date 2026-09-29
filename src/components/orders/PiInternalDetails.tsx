'use client'

// THE INTERNAL DETAILS' SUBMIT-DIALOG REVIEW AND THE DISCOUNT WORDING NOTICE
// (20270122000000).
//
// The middleman answer used to be repeated in the PI summary. It is asked and
// shown once now, in Internal order details (PiOrderDetailsSection), so this
// file keeps only what the Submit dialog reviews and the discount notice.

import { Fragment } from 'react'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { SUBMISSION_CONFIRM_LABEL } from '@/lib/orders/piInternalDetails'
import { ORDER_DETAILS_TITLE, orderDetailsAbsent, type OrderDetailsReviewRow } from '@/lib/orders/salesOrderDetails'

const label: React.CSSProperties = { fontSize: '11.5px', fontWeight: 600, color: colors.secondary }
const fieldError: React.CSSProperties = { fontSize: '11.5px', color: colors.red }

/** The deduction row's wording, flagged where a client would read it wrongly. */
export function PiDiscountWordingNotice({ notice }: { notice: string | null }) {
  if (!notice) return null
  return (
    <div
      role="note"
      style={{
        display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12.5px', color: colors.primary,
        border: `1px solid ${colors.amber}`, background: colors.amberTint, borderRadius: '10px', padding: '10px 14px',
      }}
    >
      <AlertTriangle size={15} color={colors.amber} aria-hidden style={{ flexShrink: 0, marginTop: '1px' }} />
      <span>{notice}</span>
    </div>
  )
}

/**
 * What the Submit dialog says about confirming. `needed` is true exactly when
 * pressing Submit will write the internal details (submissionNeedsConfirmation);
 * then the tick is required and starts UNTICKED. When nothing will be written,
 * the line says the details are already confirmed.
 */
export type SubmissionConfirmation = {
  needed: boolean
  checked: boolean
  onToggle: (checked: boolean) => void
  /** Shown only after Submit was pressed without the tick. */
  error?: string | null
  /** "26 Sep 2026" when the record is confirmed and nothing will change. */
  confirmedOn?: string | null
}

/**
 * THE INTERNAL ORDER DETAILS, REVIEWED INSIDE SUBMIT FOR APPROVAL.
 *
 * Nothing is entered here any more: every value was entered in the PI Draft's
 * Internal order details section, and this states them for a last look. What
 * this still asks for is the existing explicit confirmation — unticked, and
 * required whenever Submit will write it (submissionNeedsConfirmation). A
 * missing required value is said in words and Submit waits; the way to fix it
 * is the section, not a second form.
 */
export function PiSubmissionDetailsReview({ rows, missing, confirmation, confirmRef }: {
  rows: readonly OrderDetailsReviewRow[]
  /** Why Submit must wait on these details, or null. */
  missing: string | null
  confirmation?: SubmissionConfirmation
  confirmRef?: (el: HTMLInputElement | null) => void
}) {
  return (
    <fieldset style={{ border: `1px solid ${colors.border}`, borderRadius: '8px', padding: '12px 14px', margin: 0, minWidth: 0 }}>
      <legend style={{ ...label, padding: '0 4px', color: colors.primary }}>
        {ORDER_DETAILS_TITLE} <span style={{ fontWeight: 400, color: colors.tertiary }}>· BOE only</span>
      </legend>
      <dl data-testid="pi-submit-details-review" style={{ margin: 0, display: 'grid', gap: '6px 14px', gridTemplateColumns: 'minmax(0, max-content) minmax(0, 1fr)' }}>
        {rows.map(row => (
          <Fragment key={row.key}>
            <dt style={{ fontSize: '12px', color: colors.secondary }}>{row.label}</dt>
            <dd style={{
              margin: 0, fontSize: '12.5px', fontWeight: row.value ? 600 : 500, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap',
              color: row.value ? colors.primary : colors.tertiary,
            }}>
              {row.value ?? orderDetailsAbsent(row.need, row.key)}
            </dd>
          </Fragment>
        ))}
      </dl>
      {missing && (
        <p role="alert" style={{ margin: '10px 0 0', fontSize: '12px', color: '#8a4b12', fontWeight: 600 }}>{missing}</p>
      )}
      {confirmation && !missing && (confirmation.needed ? (
        <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12.5px', color: colors.primary, lineHeight: 1.45 }}>
            <input
              id="pi-submit-confirm-internal"
              ref={confirmRef}
              type="checkbox"
              checked={confirmation.checked}
              aria-invalid={confirmation.error ? true : undefined}
              aria-describedby={confirmation.error ? 'pi-submit-confirm-internal-error' : undefined}
              onChange={e => confirmation.onToggle(e.target.checked)}
              style={{ marginTop: '2px', flexShrink: 0 }}
            />
            <span>{SUBMISSION_CONFIRM_LABEL}</span>
          </label>
          {confirmation.error && (
            <span id="pi-submit-confirm-internal-error" role="alert" style={fieldError}>{confirmation.error}</span>
          )}
        </div>
      ) : (
        <p style={{ margin: '12px 0 0', fontSize: '11.5px', color: colors.secondary, display: 'flex', gap: '6px', alignItems: 'center' }}>
          <CheckCircle2 size={13} aria-hidden style={{ flexShrink: 0, color: colors.green }} />
          <span>Confirmed{confirmation.confirmedOn ? ` ${confirmation.confirmedOn}` : ''} — nothing here will change.</span>
        </p>
      ))}
    </fieldset>
  )
}
