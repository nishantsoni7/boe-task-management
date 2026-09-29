'use client'

// THE INTERNAL DETAILS: THE SUMMARY'S COMMISSION ANSWER AND THE EDITOR (20270122000000).
//
// The confirmation date and due date Sales confirms in the app, beside what the
// workbook itself said, and the answer to "Is there a middleman commission?".
// The dates are shown to everybody who can open the PI. The commission is shown
// only to those can_read_order_submission_commission() admits — everybody else
// sees "Restricted" (withCommission) — and to nobody outside BOE: no
// client-facing document reads any of it.
//
// The editor saves through save_order_submission_internal_details(). "Save
// draft" keeps half an answer; "Confirm details" requires the whole answer and
// is what the submission check (20270123000000) asks for.

import { Fragment } from 'react'
import { AlertTriangle, CheckCircle2, Lock } from 'lucide-react'
import { colors } from '@/lib/tokens'
import {
  INTERNAL_DETAILS_NOTE,
  INTERNAL_DETAILS_TITLE,
  describeMiddleman,
  internalDetailsReadiness,
  internalDetailsStatusLine,
  SUBMISSION_CONFIRM_LABEL,
  type PiInternalDetailsRow,
} from '@/lib/orders/piInternalDetails'
import { ORDER_DETAILS_TITLE, orderDetailsAbsent, type OrderDetailsReviewRow } from '@/lib/orders/salesOrderDetails'

const label: React.CSSProperties = { fontSize: '11.5px', fontWeight: 600, color: colors.secondary }
const fieldError: React.CSSProperties = { fontSize: '11.5px', color: colors.red }

/**
 * THE MIDDLEMAN ANSWER, IN THE PI SUMMARY beside Billing percentage.
 *
 * The two dates are not repeated here: the summary's date band prints the same
 * two columns (order_confirmation_date, due_date), and the workbook notes sit
 * under that band. What is left of the old Internal details card is the answer,
 * the one control that opens the editor, and the review-gate status line.
 * Presentation only — withCommission still decides what this viewer may read.
 */
export function PiCommissionSummary({ row, canEdit, onEdit, summaryOnly = false }: {
  row: PiInternalDetailsRow
  canEdit: boolean
  onEdit: () => void
  /**
   * The answer and nothing else: no Edit control, no warning, no status line.
   * On a page that has a Complete PI details area the middleman commission is
   * asked for THERE, once; here it is only reported.
   */
  summaryOnly?: boolean
}) {
  const readiness = internalDetailsReadiness(row)
  const statusLine = internalDetailsStatusLine(row)
  const answer = describeMiddleman(row)
  const unanswered = !row.commission_restricted && !row.middleman_commission
  return (
    <section className="pi-detail-internal" aria-label={MIDDLEMAN_LABEL}>
      <div className="pi-detail-internal-head">
        <span className="pi-detail-figure-label">{MIDDLEMAN_LABEL}</span>
        <span className="pi-detail-internal-tag" title={INTERNAL_DETAILS_NOTE}>
          <Lock size={10} strokeWidth={2.2} aria-hidden />
          BOE only
        </span>
      </div>
      {/* Top-right beside the label on a wide column; last, after the
          warning it resolves, on a phone (CSS order). */}
      {canEdit && !summaryOnly && (
        <button
          type="button"
          className="boe-btn boe-btn-ghost pi-detail-internal-action"
          onClick={onEdit}
          aria-haspopup="dialog"
          aria-label={`${readiness.ready ? 'Edit' : 'Enter and confirm'} ${INTERNAL_DETAILS_TITLE.toLowerCase()}`}
        >
          {readiness.ready ? 'Edit' : 'Enter and confirm'}
        </button>
      )}

      {/* UNANSWERED IS A STATE, like an undeclared billing percentage. */}
      {unanswered ? (
        <span className="pi-detail-state-chip">{answer}</span>
      ) : (
        <div className={row.commission_restricted ? 'pi-detail-internal-restricted' : 'pi-detail-internal-value'}>{answer}</div>
      )}

      {!summaryOnly && (
        <>
          <p className={`pi-detail-internal-status pi-detail-internal-status--${statusLine.tone}`} role="status">
            {statusLine.tone === 'ready' && <CheckCircle2 size={13} aria-hidden style={{ flexShrink: 0 }} />}
            {statusLine.tone === 'needed' && <AlertTriangle size={13} aria-hidden style={{ flexShrink: 0 }} />}
            <span>{statusLine.text}</span>
          </p>
          <p className="pi-detail-internal-note">{INTERNAL_DETAILS_NOTE}</p>
        </>
      )}
    </section>
  )
}

/** The summary's label for the answer to MIDDLEMAN_QUESTION. */
export const MIDDLEMAN_LABEL = 'Middleman commission'

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
