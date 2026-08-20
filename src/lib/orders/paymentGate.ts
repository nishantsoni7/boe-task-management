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
  | 'exception_pending'
  | 'exception_rejected'
  | 'verification_pending'
  | 'payment_required'

export const PAYMENT_POSITIONS: readonly PaymentPosition[] = [
  'standard_met', 'exception_approved', 'exception_pending',
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
  exception_pending:    'Awaiting approval to proceed below 40%',
  exception_rejected:   'Reduced-payment approval refused',
  verification_pending: 'Payment awaiting Finance verification',
  payment_required:     'Verified payment required',
}

export type PaymentPositionTone = 'green' | 'amber' | 'red' | 'blue'

export const PAYMENT_POSITION_TONE: Record<PaymentPosition, PaymentPositionTone> = {
  standard_met:         'green',
  exception_approved:   'green',
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
  exception_pending:
    `Admin approval is required to proceed below ${PAYMENT_STANDARD_PERCENT}%. Management can review the PI meanwhile; no Order number is assigned until this is decided.`,
  exception_rejected:
    'The reduced-payment exception was rejected. Update the PI before resubmitting.',
  verification_pending:
    'Payment is awaiting Finance verification. Unverified payment does not count towards the requirement.',
  payment_required:
    `Verified payment has not reached ${PAYMENT_STANDARD_PERCENT}% of the grand total.`,
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
export const PAYMENT_REASON_LABEL = `Reason for requesting Order confirmation below ${PAYMENT_STANDARD_PERCENT}% *`
export const PAYMENT_REASON_PLACEHOLDER =
  'Say why BOE should confirm this Order before the standard payment has been received…'

export const PAYMENT_TERMS_MAX_LENGTH = 500
export const PAYMENT_REASON_MAX_LENGTH = 1000

export const PAYMENT_REASON_REQUIRED =
  `Say why an Order should be confirmed below ${PAYMENT_STANDARD_PERCENT}%.`
export const PAYMENT_TERMS_REQUIRED =
  'Enter the agreed payment terms.'
export const PAYMENT_REASON_TOO_LONG =
  `A reason may be at most ${PAYMENT_REASON_MAX_LENGTH} characters.`
export const PAYMENT_TERMS_TOO_LONG =
  `Terms may be at most ${PAYMENT_TERMS_MAX_LENGTH} characters.`
export const PAYMENT_POSITION_UNKNOWN =
  'The payment position for this PI could not be read. Reload the page before submitting.'

export type PiSubmissionTerms = {
  reason: string
  paymentTerms: string
  billingTerms: string
}

export const EMPTY_SUBMISSION_TERMS: PiSubmissionTerms = {
  reason: '', paymentTerms: '', billingTerms: '',
}

export type SubmissionTermsValidation =
  | { ok: true; value: { reason: string | null; paymentTerms: string | null; billingTerms: string | null } }
  | { ok: false; message: string }

/**
 * What the submit dialog may send.
 *
 * `meetsStandard` is NULL when the payment position could not be read at all,
 * and that FAILS CLOSED: nobody submits a PI whose payment position nobody
 * knows, because the route — and therefore which fields are mandatory — is
 * exactly what is unknown.
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
}): SubmissionTermsValidation {
  const reason = input.terms.reason.trim()
  const paymentTerms = input.terms.paymentTerms.trim()
  const billingTerms = input.terms.billingTerms.trim()

  if (input.meetsStandard === null) return { ok: false, message: PAYMENT_POSITION_UNKNOWN }

  if (reason.length > PAYMENT_REASON_MAX_LENGTH) return { ok: false, message: PAYMENT_REASON_TOO_LONG }
  if (paymentTerms.length > PAYMENT_TERMS_MAX_LENGTH) return { ok: false, message: PAYMENT_TERMS_TOO_LONG }
  if (billingTerms.length > PAYMENT_TERMS_MAX_LENGTH) return { ok: false, message: PAYMENT_TERMS_TOO_LONG }

  if (!input.meetsStandard) {
    if (reason === '') return { ok: false, message: PAYMENT_REASON_REQUIRED }
    if (paymentTerms === '') return { ok: false, message: PAYMENT_TERMS_REQUIRED }
  }

  return {
    ok: true,
    value: {
      // The reason belongs to the exception and to nothing else.
      reason: input.meetsStandard || reason === '' ? null : reason,
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
  return terms.reason.trim() === ''
      && terms.paymentTerms.trim() === ''
      && terms.billingTerms.trim() === ''
}

// ── The live payment position the submit dialog shows ─────────────────────────

export type PaymentPositionLine = { key: string; label: string; value: string }

/**
 * The five figures the submit dialog prints, in the confirmed order.
 *
 * READ STRAIGHT OFF THE SUMMARY. Every one of them was computed in `numeric` in
 * the database; this only formats. `formatFigure` is injected so the dialog and
 * the payment card render money through exactly one formatter.
 */
export function paymentPositionLines(input: {
  grandTotal: string | number | null
  verifiedAmount: string | number | null
  verifiedPercent: string | number | null
  unverifiedAmount: string | number | null
  neededForStandard: string | number | null
  formatFigure: (v: string | number | null | undefined) => string
  formatPercentage: (v: string | number | null | undefined) => string
}): PaymentPositionLine[] {
  const { formatFigure: money, formatPercentage: pct } = input
  return [
    { key: 'grand',      label: 'Grand total',                 value: money(input.grandTotal) },
    { key: 'verified',   label: 'Verified payment',            value: money(input.verifiedAmount) },
    { key: 'percent',    label: 'Verified payment %',          value: pct(input.verifiedPercent) },
    { key: 'unverified', label: 'Awaiting verification',       value: money(input.unverifiedAmount) },
    { key: 'needed',     label: 'Needed for standard approval', value: money(input.neededForStandard) },
  ]
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
