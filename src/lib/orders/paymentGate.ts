// The verified-payment gate, as the browser understands it.
//
// WHAT THIS MODULE IS ABOUT
// -------------------------
// An Order number is assigned only when at least 40% of the PI's grand total has
// ACTUALLY BEEN RECEIVED AND VERIFIED BY FINANCE, or when an authorised approver
// has accepted proceeding on less. This module owns everything the browser says
// and decides about that rule: what the position is called, which fields the
// submit dialog must ask for, and what a refusal means in business language.
//
// WHAT IT IS NOT
// --------------
// NOT AUTHORIZATION, and not arithmetic either. Every figure it renders is
// computed in `numeric` in the database by pi_submission_payment_summary(), and
// every decision it renders is re-derived from scratch, under row locks, by
// approve_order_submission() and submit_pi_for_review(). Nothing here sums
// money, and nothing here can let anything happen.
//
// WHY IT IS NOT IN advanceRequirement.ts
// --------------------------------------
// That module is about a DECLARED ADVANCE — a commercial condition an employee
// stated. This one is about MONEY THAT ARRIVED. They were the same question only
// while there was no way to answer the second one. Keeping the declared advance
// where it is, unchanged, is what makes every historical record still readable;
// putting the new rule beside it rather than inside it is what stops the two
// meanings blurring back together.
//
// THE ONE PLACE THE TWO MEET is the EXCEPTION: 20260913000000's exception
// columns, its guard, its two decision RPCs and its orders.approve_advance_exception
// permission carry the reduced-payment request, because building a second
// exception system beside a working one would split the audit trail in half. So
// `advance_exception_status` is read here — as the state of a PAYMENT exception,
// which is what it now records.

import { formatInr } from '@/lib/pi/previewView'
import { ADVANCE_STANDARD_PERCENT } from './advanceRequirement'

/** The requirement, in one place, shared with the declared-advance module and
 *  mirrored by order_submission_standard_advance_percent() in SQL. */
export const PAYMENT_STANDARD_PERCENT = ADVANCE_STANDARD_PERCENT

// ── Where a PI stands ─────────────────────────────────────────────────────────

/**
 * The six positions pi_submission_payment_summary() reports, and the only six
 * this screen knows.
 *
 * THE SERVER DECIDES WHICH ONE, not the browser. `approval_position` arrives on
 * the summary already resolved, in the same order approve_order_submission()
 * resolves it — money first, then the decision that stands in for money, then
 * what is missing. Re-deriving it here from the figures would be a second
 * opinion that can disagree with the one that counts.
 */
export type PaymentPosition =
  | 'standard_met'
  | 'exception_approved'
  | 'exception_stale'
  | 'exception_pending'
  | 'exception_rejected'
  | 'verification_pending'
  | 'payment_required'

export const PAYMENT_POSITIONS: readonly PaymentPosition[] = [
  'standard_met', 'exception_approved', 'exception_stale', 'exception_pending',
  'exception_rejected', 'verification_pending', 'payment_required',
]

export function asPaymentPosition(value: string | null | undefined): PaymentPosition | null {
  if (!value) return null
  return (PAYMENT_POSITIONS as readonly string[]).includes(value)
    ? value as PaymentPosition
    : null
}

export const PAYMENT_POSITION_LABEL: Record<PaymentPosition, string> = {
  standard_met:         'Standard payment requirement met',
  exception_approved:   'Approved to proceed below 40%',
  exception_stale:      'Reduced-payment approval is out of date',
  exception_pending:    'Awaiting approval to proceed below 40%',
  exception_rejected:   'Reduced-payment approval refused',
  verification_pending: 'Payment awaiting Finance verification',
  payment_required:     'Verified payment required',
}

export type PaymentPositionTone = 'green' | 'amber' | 'red' | 'blue'

export const PAYMENT_POSITION_TONE: Record<PaymentPosition, PaymentPositionTone> = {
  standard_met:         'green',
  exception_approved:   'green',
  exception_stale:      'amber',
  exception_pending:    'amber',
  exception_rejected:   'red',
  verification_pending: 'blue',
  payment_required:     'amber',
}

/**
 * One sentence under each position, saying whose move it is.
 *
 * Every one of them is ACTIONABLE and belongs to somebody. "Not enough payment"
 * is a state; "₹4,00,000 more verified payment is needed, or Admin approval to
 * proceed below 40%" is a next step.
 */
export const PAYMENT_POSITION_HINT: Record<PaymentPosition, string> = {
  standard_met:
    `Verified payment is at or above ${PAYMENT_STANDARD_PERCENT}% of the grand total. No approval to proceed below is needed.`,
  exception_approved:
    `Admin has approved confirming this Order below ${PAYMENT_STANDARD_PERCENT}%.`,
  exception_stale:
    'The approval to proceed below 40% was given for different commercial terms — the grand total, the PI document or the agreed terms have changed since. It must be approved again.',
  exception_pending:
    `Admin approval is required to proceed below ${PAYMENT_STANDARD_PERCENT}%. Management can review the PI meanwhile; no Order number is assigned until this is decided.`,
  exception_rejected:
    'The reduced-payment exception was rejected. Update the PI before resubmitting.',
  verification_pending:
    'Payment is awaiting Finance verification. Unverified payment does not count towards the requirement.',
  payment_required:
    `Verified payment has not reached ${PAYMENT_STANDARD_PERCENT}% of the grand total.`,
}

// ── Where a PI stands for SUBMISSION ──────────────────────────────────────────
//
// A SECOND, NARROWER QUESTION than the approval position above, and deliberately
// a separate vocabulary: the Order gate asks how much VERIFIED money there is;
// the submission rule (20261119000000) asks how much is ATTACHED — verified plus
// reported-but-undecided — because an employee whose client has paid should not
// have to argue for an exception while Finance has not yet looked. Below 40%
// attached, zero included, a reason is owed before management is asked.
//
// THE SERVER DECIDES WHICH ONE. `submission_position` arrives on the summary,
// resolved in numeric by pi_submission_payment_summary(), and
// submit_pi_for_review_internal() re-derives the same answer under row locks.

export type SubmissionPosition = 'attached_met' | 'attached_partial' | 'no_payment'

export const SUBMISSION_POSITIONS: readonly SubmissionPosition[] = [
  'attached_met', 'attached_partial', 'no_payment',
]

export function asSubmissionPosition(value: string | null | undefined): SubmissionPosition | null {
  if (!value) return null
  return (SUBMISSION_POSITIONS as readonly string[]).includes(value)
    ? value as SubmissionPosition
    : null
}

export const SUBMISSION_POSITION_LABEL: Record<SubmissionPosition, string> = {
  attached_met:     `Attached payment is at or above ${PAYMENT_STANDARD_PERCENT}%`,
  attached_partial: `Attached payment is below ${PAYMENT_STANDARD_PERCENT}%`,
  no_payment:       'No payment is attached to this PI',
}

/**
 * The sentence that asks for the reason, naming the figure it is about.
 *
 * "Only 27% payment is currently attached" says what management will see;
 * "No payment is attached" says the same for zero. The percentage is the
 * server's, formatted by the caller, and is never computed here.
 */
export function submissionReasonPrompt(
  position: SubmissionPosition,
  attachedPercentLabel: string | null,
): string {
  if (position === 'no_payment') {
    return 'No payment is attached to this PI. Choose why it should still be sent for approval.'
  }
  const figure = attachedPercentLabel && attachedPercentLabel.trim() !== ''
    ? attachedPercentLabel.trim()
    : `less than ${PAYMENT_STANDARD_PERCENT}%`
  return `Only ${figure} payment is currently attached. Choose why this PI should still be sent for approval.`
}

// ── The words a refusal uses ──────────────────────────────────────────────────
//
// Business language, always. The database's own message carries statement text
// and ids and never reaches a screen — these sentences are what a salesperson or
// a reviewer reads instead, and they say what to DO.

export const PAYMENT_MORE_REQUIRED = (amount: string): string =>
  `${amount} more verified payment is required for standard approval.`
export const PAYMENT_AWAITING_VERIFICATION =
  'Payment is awaiting Finance verification.'
export const PAYMENT_ADMIN_APPROVAL_REQUIRED =
  `Admin approval is required to proceed below ${PAYMENT_STANDARD_PERCENT}%.`
export const PAYMENT_EXCEPTION_PENDING =
  'The reduced-payment exception is still pending.'
export const PAYMENT_EXCEPTION_REJECTED =
  'The reduced-payment exception was rejected. Update the PI before resubmitting.'
export const PAYMENT_EXCEPTION_STALE =
  'The reduced-payment approval was given for different commercial terms and must be approved again.'
export const PAYMENT_EXCEPTION_REASON_FROZEN =
  'The reason an approved reduced-payment exception was granted for cannot be rewritten. Resubmit to ask again.'
export const PAYMENT_ALLOCATION_NOT_MOVED =
  'This PI\u2019s payments could not be moved onto the Order, so no Order was created. Refresh and try once more.'
export const PAYMENT_UNVERIFIED_DOES_NOT_COUNT =
  'Payment that Finance has not verified does not count towards the requirement.'
export const PAYMENT_NOT_A_DECLARATION =
  'Only payment Finance has verified counts. Nothing here records or requests money.'

// ── The submit dialog's fields ────────────────────────────────────────────────

export const PAYMENT_TERMS_LABEL = 'Payment terms *'
export const PAYMENT_TERMS_OPTIONAL_LABEL = 'Payment terms (optional)'
export const PAYMENT_TERMS_PLACEHOLDER = 'e.g. 30% advance, 30% during production, 40% before dispatch'
export const BILLING_TERMS_LABEL = 'Billing terms (optional)'
export const BILLING_TERMS_PLACEHOLDER = 'e.g. 100% invoice before dispatch'
export const PAYMENT_REASON_LABEL = `Why should this PI go ahead below ${PAYMENT_STANDARD_PERCENT}%? *`

// ── The three reasons (20270114000000) ────────────────────────────────────────
//
// EXACTLY THREE, and the words are the ones stored. The database accepts only
// 'Against client PO', 'Sample order' or 'Other: <remark>' and files each under
// advance_exception_reason_code, so what the admin reads is what was chosen.
// Choosing one is a REQUEST: the exception stays pending until an admin with
// the exception permission decides it, and the Order gate still refuses until
// then.

export type ExceptionReasonChoice = 'against_client_po' | 'sample_order' | 'other'

export const EXCEPTION_REASON_OPTIONS: readonly { value: ExceptionReasonChoice; label: string }[] = [
  { value: 'against_client_po', label: 'Against client PO' },
  { value: 'sample_order',      label: 'Sample order' },
  { value: 'other',             label: 'Other' },
]

/** The shortest remark "Other" accepts — the database's rule, stated once here. */
export const OTHER_REMARK_MIN_LENGTH = 10
export const OTHER_REMARK_LABEL = 'Remark *'
export const OTHER_REMARK_PLACEHOLDER = 'Say what makes this order different, so an admin can decide'
export const OTHER_REMARK_REQUIRED =
  `Add a remark of at least ${OTHER_REMARK_MIN_LENGTH} characters to explain Other.`
export const EXCEPTION_REASON_NOT_A_DECISION =
  'Choosing a reason does not approve anything. An admin decides whether this PI may go ahead below the standard payment.'
export const EXCEPTION_REASON_INVALID =
  `Choose Against client PO, Sample order, or Other with a remark of at least ${OTHER_REMARK_MIN_LENGTH} characters.`

/** The text stored for a choice, exactly as the database expects it. */
export function composeExceptionReason(choice: ExceptionReasonChoice | '', remark: string): string | null {
  if (choice === 'against_client_po') return 'Against client PO'
  if (choice === 'sample_order') return 'Sample order'
  if (choice === 'other') {
    const text = remark.trim()
    return text.length >= OTHER_REMARK_MIN_LENGTH ? `Other: ${text}` : null
  }
  return null
}

/**
 * A stored reason read back into the dialog. A reason written before the three
 * existed (free text) is not forced into a category: it opens unchosen, so the
 * employee picks one again rather than having one picked for them.
 */
export function readExceptionReason(stored: string | null | undefined): { choice: ExceptionReasonChoice | ''; remark: string } {
  const text = (stored ?? '').trim()
  if (text === 'Against client PO') return { choice: 'against_client_po', remark: '' }
  if (text === 'Sample order') return { choice: 'sample_order', remark: '' }
  if (text.startsWith('Other: ')) return { choice: 'other', remark: text.slice('Other: '.length) }
  return { choice: '', remark: '' }
}

/**
 * An APPROVED exception this PI still holds (same reason, same figures) whose
 * reason was written before the three existed. A PI returned for an unrelated
 * correction resubmits with it word for word — the database keeps the
 * approval (20270114000000) — rather than making the employee re-categorise it
 * and sending an approved exception back to pending. Null when there is none.
 */
export function keptExceptionReason(p: {
  exception_status?: string | null
  exception_current?: boolean | null
  exception_reason?: string | null
} | null | undefined): string | null {
  const text = (p?.exception_reason ?? '').trim()
  if (text === '' || p?.exception_status !== 'approved' || p?.exception_current !== true) return null
  return readExceptionReason(text).choice === '' ? text : null
}

export const exceptionReasonKept = (reason: string): string =>
  `The approved exception stands: “${reason}”. Resubmitting keeps it. Choose a reason only to replace it — an admin would then decide again.`

export const PAYMENT_TERMS_MAX_LENGTH = 500
export const PAYMENT_REASON_MAX_LENGTH = 1000

export const PAYMENT_REASON_REQUIRED =
  `Choose why this PI should go ahead below ${PAYMENT_STANDARD_PERCENT}%.`
export const PAYMENT_TERMS_REQUIRED =
  'Enter the agreed payment terms.'
export const PAYMENT_REASON_TOO_LONG =
  `A reason may be at most ${PAYMENT_REASON_MAX_LENGTH} characters.`
export const PAYMENT_TERMS_TOO_LONG =
  `Terms may be at most ${PAYMENT_TERMS_MAX_LENGTH} characters.`
export const PAYMENT_POSITION_UNKNOWN =
  'The payment position for this PI could not be read. Reload the page before submitting.'

export type PiSubmissionTerms = {
  /** One of the three, or '' while nothing is chosen. */
  reasonChoice: ExceptionReasonChoice | ''
  /** The remark "Other" requires. Ignored for the other two. */
  otherRemark: string
  paymentTerms: string
  billingTerms: string
}

export const EMPTY_SUBMISSION_TERMS: PiSubmissionTerms = {
  reasonChoice: '', otherRemark: '', paymentTerms: '', billingTerms: '',
}

export type SubmissionTermsValidation =
  | { ok: true; value: { reason: string | null; paymentTerms: string | null; billingTerms: string | null } }
  | { ok: false; message: string }

/**
 * What the submit dialog may send.
 *
 * `meetsStandard` is whether ATTACHED payment (verified + awaiting verification)
 * reaches the requirement — `attached_meets_standard` on the summary, since
 * 20261119000000 — and NULL when the payment position could not be read at all.
 * A null FAILS CLOSED: nobody submits a PI whose payment position nobody knows,
 * because the route — and therefore which fields are mandatory — is exactly what
 * is unknown.
 *
 * WHEN THE REQUIREMENT IS MET the reason is not asked for and is not sent. A
 * reason typed before a payment landed is not a request the business still needs
 * to answer, and sending it would raise an exception nobody has to decide.
 *
 * TERMS ARE ALWAYS SENT WHEN PRESENT. Payment Terms are mandatory only below the
 * requirement, but a salesperson who states them on a fully paid order is
 * recording a real commercial fact and it is kept.
 */
export function validateSubmissionTerms(input: {
  meetsStandard: boolean | null
  terms: PiSubmissionTerms
  /** keptExceptionReason(): sent unchanged while no new reason is chosen. */
  keptReason?: string | null
}): SubmissionTermsValidation {
  const { reasonChoice } = input.terms
  const remark = input.terms.otherRemark.trim()
  const paymentTerms = input.terms.paymentTerms.trim()
  const billingTerms = input.terms.billingTerms.trim()

  if (input.meetsStandard === null) return { ok: false, message: PAYMENT_POSITION_UNKNOWN }

  if (remark.length > PAYMENT_REASON_MAX_LENGTH - 'Other: '.length) return { ok: false, message: PAYMENT_REASON_TOO_LONG }
  if (paymentTerms.length > PAYMENT_TERMS_MAX_LENGTH) return { ok: false, message: PAYMENT_TERMS_TOO_LONG }
  if (billingTerms.length > PAYMENT_TERMS_MAX_LENGTH) return { ok: false, message: PAYMENT_TERMS_TOO_LONG }

  // Below the requirement: one of the three, and a real remark for Other.
  // Payment Terms are no longer demanded (20270114000000).
  const kept = input.keptReason?.trim() || null
  const reason = reasonChoice === '' ? kept : composeExceptionReason(reasonChoice, remark)
  if (!input.meetsStandard) {
    if (reason === null && reasonChoice === '') return { ok: false, message: PAYMENT_REASON_REQUIRED }
    if (reason === null) return { ok: false, message: OTHER_REMARK_REQUIRED }
  }

  return {
    ok: true,
    value: {
      // The reason belongs to the exception and to nothing else.
      reason: input.meetsStandard ? null : reason,
      paymentTerms: paymentTerms === '' ? null : paymentTerms,
      billingTerms: billingTerms === '' ? null : billingTerms,
    },
  }
}

/**
 * Whether the dialog should stay quiet about a field somebody has not reached
 * yet. A person who has just opened the dialog has not made a mistake; a red
 * sentence about a reason they were about to type is scolding, not help.
 */
export function submissionTermsUntouched(terms: PiSubmissionTerms): boolean {
  return terms.reasonChoice === ''
      && terms.otherRemark.trim() === ''
      && terms.paymentTerms.trim() === ''
      && terms.billingTerms.trim() === ''
}

// ── The live payment position the submit dialog shows ─────────────────────────

export type PaymentPositionLine = { key: string; label: string; value: string }

/**
 * The figures the submit dialog prints, in the confirmed order.
 *
 * READ STRAIGHT OFF THE SUMMARY. Every one of them was computed in `numeric` in
 * the database; this only formats. `formatFigure` is injected so the dialog and
 * the payment card render money through exactly one formatter.
 *
 * The two ATTACHED lines are optional so a caller holding an older summary still
 * prints the five it always had; when the server reports them, they follow the
 * unverified line, because attached = verified + awaiting verification and the
 * total reads best after its parts.
 */
export function paymentPositionLines(input: {
  grandTotal: string | number | null
  verifiedAmount: string | number | null
  verifiedPercent: string | number | null
  unverifiedAmount: string | number | null
  unverifiedPercent?: string | number | null
  attachedAmount?: string | number | null
  attachedPercent?: string | number | null
  neededForStandard: string | number | null
  formatFigure: (v: string | number | null | undefined) => string
  formatPercentage: (v: string | number | null | undefined) => string
}): PaymentPositionLine[] {
  const { formatFigure: money, formatPercentage: pct } = input
  const lines: PaymentPositionLine[] = [
    { key: 'grand',      label: 'Grand total',                 value: money(input.grandTotal) },
    { key: 'verified',   label: 'Verified payment',            value: money(input.verifiedAmount) },
    { key: 'percent',    label: 'Verified payment %',          value: pct(input.verifiedPercent) },
    { key: 'unverified', label: 'Awaiting verification',       value: money(input.unverifiedAmount) },
  ]
  if (input.unverifiedPercent !== undefined) {
    lines.push({ key: 'unverifiedPercent', label: 'Awaiting verification %', value: pct(input.unverifiedPercent) })
  }
  if (input.attachedAmount !== undefined) {
    lines.push({ key: 'attached', label: 'Total attached payment', value: money(input.attachedAmount) })
  }
  if (input.attachedPercent !== undefined) {
    lines.push({ key: 'attachedPercent', label: 'Total attached payment %', value: pct(input.attachedPercent) })
  }
  lines.push({ key: 'needed', label: 'Needed for standard approval', value: money(input.neededForStandard) })
  return lines
}

// ── The refusals the database can give, in business language ──────────────────

/**
 * The coded refusals approve_order_submission() and submit_pi_for_review() raise,
 * turned into a sentence somebody can act on.
 *
 * ORDERED, and the order matters: the first marker found wins, so the more
 * specific codes are listed before the ones they contain.
 */
export const PAYMENT_GATE_FAILURES: readonly { marker: string; message: string }[] = [
  {
    marker: 'ORDER_SUBMISSION_PAYMENT_AWAITING_VERIFICATION',
    message: `${PAYMENT_AWAITING_VERIFICATION} It does not count until Finance verifies it. ${PAYMENT_ADMIN_APPROVAL_REQUIRED}`,
  },
  {
    marker: 'ORDER_SUBMISSION_PAYMENT_INSUFFICIENT',
    message: `Verified payment has not reached ${PAYMENT_STANDARD_PERCENT}% of the grand total. ${PAYMENT_ADMIN_APPROVAL_REQUIRED}`,
  },
  { marker: 'ORDER_SUBMISSION_EXCEPTION_PENDING',  message: PAYMENT_EXCEPTION_PENDING },
  { marker: 'ORDER_SUBMISSION_EXCEPTION_STALE',    message: PAYMENT_EXCEPTION_STALE },
  { marker: 'ORDER_SUBMISSION_EXCEPTION_REASON_FROZEN', message: PAYMENT_EXCEPTION_REASON_FROZEN },
  { marker: 'ORDER_SUBMISSION_ALLOCATION_NOT_MOVED', message: PAYMENT_ALLOCATION_NOT_MOVED },
  { marker: 'ORDER_SUBMISSION_EXCEPTION_REJECTED', message: PAYMENT_EXCEPTION_REJECTED },
  { marker: 'ORDER_SUBMISSION_EXCEPTION_REASON_REQUIRED', message: PAYMENT_REASON_REQUIRED },
  { marker: 'ORDER_SUBMISSION_PAYMENT_TERMS_REQUIRED',    message: PAYMENT_TERMS_REQUIRED },
  { marker: 'ORDER_SUBMISSION_TERMS_TOO_LONG',            message: PAYMENT_TERMS_TOO_LONG },
]

/**
 * The exact shortfall, when the summary knows it, phrased as the business
 * phrases it. Null when there is nothing outstanding or nothing readable — a
 * sentence naming ₹0 would say the opposite of what it means.
 */
export function shortfallSentence(neededForStandard: string | number | null | undefined): string | null {
  if (neededForStandard === null || neededForStandard === undefined || neededForStandard === '') return null
  const n = typeof neededForStandard === 'number' ? neededForStandard : Number(neededForStandard)
  if (!Number.isFinite(n) || n <= 0) return null
  return PAYMENT_MORE_REQUIRED(formatInr(n))
}
