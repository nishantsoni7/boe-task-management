// Deleting one payment entry — the single implementation, shared by every
// Finance surface that offers the action.
//
// REVISED RULE (20261011000000): deletion is an Admin-only action, for a
// payment of ANY status — Payment Requests (pending_approval,
// needs_clarification, rejected) and Confirmed Payments (approved_unlinked,
// approved_linked) alike. Self-delete by the submitter of an unapproved
// payment, which the previous rule allowed, is withdrawn: finance_payment_
// deletable_by (20261011000000 §3a) now checks only that the caller is an
// active admin, so an initiator who is not an admin never reaches this action
// for their own payment either.
//
// NOTHING HERE IS A NEW RULE, AND NOTHING HERE IS AUTHORITY. Every protection
// this action relies on is in the database:
//
//   finance_payment_requests_guard_approved_delete (20260705000000, widened
//   by 20261011000000 §3c)
//     BEFORE DELETE. Refuses every caller deleting an approved payment EXCEPT
//     an authorized module reset or the one finalize_finance_payment_deletion
//     transaction that has already passed admin authorization, the durable
//     claim, the reason gate and the typed-Payment-ID confirmation for that
//     exact payment. This is what makes "only the durable claim protocol can
//     delete a Confirmed Payment" true rather than merely intended.
//
//   finance_payment_requests_release_allocations (20260918000000 §8a)
//     Deletes the payment's allocations in the same statement as the payment
//     — atomic with the delete or it does not happen at all.
//
//   finance_payment_deletable_by (20261011000000 §3a)
//     Admin, active, not soft-deleted. Re-derived on every attempt by
//     begin_finance_payment_deletion and finalize_finance_payment_deletion,
//     never inherited from whoever opened the claim.
//
// THE DURABLE CLAIM PROTOCOL (20261010000000 §11, extended by 20261011000000
// §§2-3) is what actually deletes a payment: it freezes verification, proof
// mutation and allocation change before anything is touched, sweeps the proof
// manifest, and only then deletes the row — via /api/finance/payments/delete.
// This module supplies the client-facing policy (who sees the button, what it
// asks for) and calls that route; it holds no delete logic of its own.

import { REQUEST_STAGE_STATUSES, CONFIRMED_PAYMENT_STATUSES } from '@/app/finance/paymentRouting'

/**
 * Every status a payment may carry — and, since the revised rule is
 * Admin-only rather than status-gated, every status an Admin may delete from.
 * A Finance-only user or the payment's own submitter sees no Delete action at
 * all; canDeletePayment below is the single gate.
 */
export const DELETABLE_PAYMENT_STATUSES = [
  ...REQUEST_STAGE_STATUSES,
  ...CONFIRMED_PAYMENT_STATUSES,
] as const

export function isPaymentDeletableStatus(status: string | null | undefined): boolean {
  return (DELETABLE_PAYMENT_STATUSES as readonly string[]).includes(status ?? '')
}

/**
 * Whether a Confirmed Payment is being deleted — the exceptional financial
 * action that requires a reason and the typed Payment ID rather than a plain
 * confirmation. Payment Requests use the same two gates (see
 * begin_finance_payment_deletion, which requires both for every status), but
 * the UI's summary/warning copy differs for a Confirmed Payment.
 */
export function isConfirmedPaymentStatus(status: string | null | undefined): boolean {
  return (CONFIRMED_PAYMENT_STATUSES as readonly string[]).includes(status ?? '')
}

/**
 * Who may delete this payment — ADMIN ONLY, for any status.
 *
 * THIS DECIDES VISIBILITY, NEVER PERMISSION. finance_payment_deletable_by
 * re-derives the actor and finance_payment_requests_guard_approved_delete /
 * the deletion-claim triggers re-derive the state, against the committed row,
 * at the moment of each RPC call. A non-admin who somehow reaches this action
 * meets PAYMENT_DELETION_DENIED from the database regardless of what this
 * function says.
 */
export function canDeletePayment(
  payment: { status: string },
  actor: { isAdmin: boolean },
): boolean {
  if (!isPaymentDeletableStatus(payment.status)) return false
  return actor.isAdmin
}

export const PAYMENT_DELETE_ALLOCATION_WARNING =
  'Any allocations of this payment to an Order or a PI Draft are released with it,'
  + ' and the affected PI Draft and Order payment totals will change.'

export const PAYMENT_DELETE_CONFIRM_LABEL = 'Delete Payment'
export const PAYMENT_DELETE_BUSY_LABEL    = 'Deleting…'
export const PAYMENT_DELETE_TITLE         = 'Delete Payment'

export const PAYMENT_DELETE_REASON_LABEL = 'Reason for deletion'
export const PAYMENT_DELETE_REASON_PLACEHOLDER = 'Why is this payment being deleted?'

export function paymentDeleteConfirmIdLabel(humanPaymentId: string): string {
  return `Type ${humanPaymentId} to confirm`
}

export type PaymentDeletionResult =
  | { outcome: 'success'; allocationsReleased: number; alreadyDeleted: boolean }
  | { outcome: 'failure'; code: string; message: string; retryable: boolean }

export type DeletablePayment = {
  id: string
  human_payment_id: string
  status: string
}

/**
 * Delete one payment entry, through the durable claim protocol.
 *
 * A THIN CLIENT OVER /api/finance/payments/delete. Every decision — who may
 * delete, whether the reason and typed Payment ID are valid, whether the
 * proof manifest is fully swept before the row goes — is the server route's
 * and the RPCs' behind it. This function's only job is the fetch, and turning
 * whatever comes back into the one shape callers render.
 */
export async function deletePaymentEntry(
  payment: DeletablePayment,
  reason: string,
  confirmPaymentId: string,
): Promise<PaymentDeletionResult> {
  let body: { ok?: boolean; code?: string; allocationsReleased?: number; alreadyDeleted?: boolean } | null = null
  try {
    const response = await fetch('/api/finance/payments/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paymentId: payment.id, reason, confirmPaymentId }),
    })
    body = await response.json().catch(() => null)
  } catch {
    return { outcome: 'failure', code: 'DELETE_FAILED', message: 'Network error. Nothing was deleted.', retryable: true }
  }

  if (body?.ok === true) {
    return {
      outcome: 'success',
      allocationsReleased: body.allocationsReleased ?? 0,
      alreadyDeleted: body.alreadyDeleted === true,
    }
  }

  const { describePaymentDeletionFailure } = await import('@/lib/finance/paymentDeletionProtocol')
  const failure = describePaymentDeletionFailure(body?.code)
  return { outcome: 'failure', code: failure.code, message: failure.message, retryable: failure.retryable }
}

/**
 * What this payment currently pays for, in one sentence — or null when it pays
 * for nothing and there is nothing to warn about.
 *
 * COUNTS AND KINDS ONLY, never a name, a client or an amount per destination.
 * The reader of this dialog already knows which payment they are deleting;
 * anything more would be telling a browser about records its own row-level
 * security may forbid it to read — the same boundary linkCounts draws.
 */
export function describePaymentAllocations(
  links: readonly { kind: 'order' | 'submission' }[],
): string | null {
  const orders = links.filter(link => link.kind === 'order').length
  const submissions = links.filter(link => link.kind === 'submission').length
  const parts: string[] = []
  if (orders > 0) {
    parts.push(orders === 1 ? '1 Order' : `${orders} Orders`)
  }
  if (submissions > 0) {
    parts.push(submissions === 1 ? '1 PI Draft' : `${submissions} PI Drafts`)
  }
  if (parts.length === 0) return null
  return `This payment is currently allocated to ${parts.join(' and ')}.`
}
