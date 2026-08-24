// The durable payment-deletion protocol, in the words the screen shows.
//
// This is the client-side half of §11 of 20261010000000 — the migration that
// makes deleting a payment that owns files safe. It maps what the database said
// to what the operator is told, and it is deliberately separate from
// paymentDeletion.ts: that module is the zero-proof path that needs no claim at
// all, and it must keep working on a deployment where this migration has not
// been applied.
//
// NOTHING HERE DECIDES ANYTHING. Every refusal below was already decided by a
// SECURITY DEFINER function under a row lock.

export type PaymentDeletionCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  /** Verified money. Permanent bank history, and never claimable. */
  | 'APPROVED'
  /** The claim is not current — released, or belonging to another attempt. */
  | 'CLAIM_INVALID'
  /** Finalization refused because an object is still in the bucket. */
  | 'PROOF_PENDING'
  /** A release was refused because files have already gone; finish it instead. */
  | 'IN_PROGRESS'
  /** The sweep left something behind. The claim stands and a retry resumes. */
  | 'STORAGE_INCOMPLETE'
  | 'STORAGE_UNAVAILABLE'
  | 'DELETE_FAILED'

/**
 * The sentence for a deletion that stopped part-way.
 *
 * IT DOES NOT SAY THE PAYMENT WAS DELETED, because it was not: the claim is
 * still standing, the payment and its allocations are intact, and whatever is
 * left in the bucket is named by a manifest that is still readable. Pressing
 * again resumes from there.
 */
export const PAYMENT_DELETE_RETRY_MESSAGE = 'Payment deletion did not finish. Retry deletion.'

export const PAYMENT_DELETE_RETRY_LABEL = 'Retry deletion'

type Copy = { message: string; retryable: boolean }

const FAILURE_COPY: Record<PaymentDeletionCode, Copy> = {
  UNAUTHORIZED: { message: 'Please sign in again.', retryable: false },
  FORBIDDEN: {
    message: 'You do not have permission to delete this payment.', retryable: false },
  NOT_FOUND: {
    message: 'This payment no longer exists.', retryable: false },
  APPROVED: {
    message: 'This payment has been verified and is permanent bank payment history.'
      + ' It can no longer be deleted.', retryable: false },
  // Every one of these three means the SAME thing to the operator: some stage
  // did not finish, nothing is lost, and pressing again picks up where it
  // stopped. They are separate codes because they are separate causes, and the
  // server log should say which — but one honest sentence serves all three.
  CLAIM_INVALID:      { message: PAYMENT_DELETE_RETRY_MESSAGE, retryable: true },
  PROOF_PENDING:      { message: PAYMENT_DELETE_RETRY_MESSAGE, retryable: true },
  STORAGE_INCOMPLETE: { message: PAYMENT_DELETE_RETRY_MESSAGE, retryable: true },
  IN_PROGRESS: {
    message: 'This payment’s proof files have already been removed, so the deletion must be'
      + ' finished. Retry deletion.', retryable: true },
  STORAGE_UNAVAILABLE: {
    message: 'Payment deletion is not configured on this deployment.'
      + ' Nothing was removed.', retryable: false },
  DELETE_FAILED: { message: PAYMENT_DELETE_RETRY_MESSAGE, retryable: true },
}

export type PaymentDeletionFailure = Copy & { code: PaymentDeletionCode }

export function isPaymentDeletionCode(value: unknown): value is PaymentDeletionCode {
  return typeof value === 'string' && value in FAILURE_COPY
}

export function describePaymentDeletionFailure(code: unknown): PaymentDeletionFailure {
  const known: PaymentDeletionCode = isPaymentDeletionCode(code) ? code : 'DELETE_FAILED'
  return { code: known, ...FAILURE_COPY[known] }
}

/**
 * Which code a raw database error means.
 *
 * The markers are the ones §11 raises, matched by name. The approved marker is
 * checked FIRST: it is the one refusal that must never be softened into
 * something retryable, because retrying it forever will not make verified money
 * deletable.
 */
const RPC_MARKERS: readonly { marker: string; code: PaymentDeletionCode }[] = [
  { marker: 'PAYMENT_APPROVED_PERMANENT',        code: 'APPROVED' },
  { marker: 'PAYMENT_DELETION_NOT_AUTHENTICATED', code: 'UNAUTHORIZED' },
  { marker: 'PAYMENT_DELETION_DENIED',           code: 'FORBIDDEN' },
  { marker: 'PAYMENT_DELETION_NOT_FOUND',        code: 'NOT_FOUND' },
  { marker: 'PAYMENT_DELETION_PROOF_PENDING',    code: 'PROOF_PENDING' },
  { marker: 'PAYMENT_DELETION_IN_PROGRESS',      code: 'IN_PROGRESS' },
  { marker: 'PAYMENT_DELETION_CLAIM_INVALID',    code: 'CLAIM_INVALID' },
  { marker: 'PAYMENT_DELETION_PATH_UNKNOWN',     code: 'DELETE_FAILED' },
  // The freeze itself, met by something that is not this deletion.
  { marker: 'PAYMENT_DELETION_CLAIMED',          code: 'CLAIM_INVALID' },
]

export function classifyPaymentDeletionError(error: unknown): PaymentDeletionCode {
  const raw = typeof error === 'string'
    ? error
    : ((error as { message?: string } | null)?.message ?? '')
  for (const { marker, code } of RPC_MARKERS) {
    if (raw.includes(marker)) return code
  }
  return 'DELETE_FAILED'
}
