// ── The four words for a payment's state ─────────────────────────────────────
//
// Payments counted once (owner, 2026-10-29): one set of words on every screen.
// Before this, a payment waiting for Finance read "Awaiting Verification" on the
// PI, "Pending" in Finance and "Pending Review" in its history, and a verified
// one read "Verified" on the PI and "Received Payment" in Finance. A new member
// of staff reads three words as three different things.
//
// The stored statuses do not change; only what is printed for them.

export const WAITING_FOR_FINANCE = 'Waiting for Finance'
export const VERIFIED = 'Verified'
export const NEEDS_CLARIFICATION = 'Needs Clarification'
export const REJECTED = 'Rejected'

/** finance_payment_requests.status → the word every screen prints. */
export const PAYMENT_STATUS_WORD: Record<string, string> = {
  pending_approval:    WAITING_FOR_FINANCE,
  needs_clarification: NEEDS_CLARIFICATION,
  rejected:            REJECTED,
  approved_unlinked:   VERIFIED,
  approved_linked:     VERIFIED,
}

/** The word for a stored status; an unknown value is printed as it is. */
export function paymentStatusWord(status: string | null | undefined): string {
  return (status && PAYMENT_STATUS_WORD[status]) || String(status ?? '')
}

/** Where a payment is on the tracker: done, waiting, a problem. */
export type PaymentStepTone = 'done' | 'waiting' | 'problem'

export function paymentStepTone(status: string | null | undefined): PaymentStepTone {
  if (status === 'approved_linked' || status === 'approved_unlinked') return 'done'
  if (status === 'rejected') return 'problem'
  return 'waiting'
}
