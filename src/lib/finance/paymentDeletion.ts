// Deleting one payment entry — the single implementation, shared by every
// Finance surface that offers the action.
//
// WHY THIS FILE EXISTS
// --------------------
// The PI deletion blocker tells an operator, in as many words, to "delete those
// payment entries in Finance first". That instruction was impossible to follow
// from the page the operator was looking at: an allocated payment appears on
// RECEIVED PAYMENTS, and Received Payments had a View, an Allocate, a Link and
// an Unlink — and no Delete. The only Delete in the product lived on the Payment
// Requests page, which does not load an allocated payment's row when it has
// reached a status that page has handed over.
//
// So the capability existed and the route to it did not. This module is that
// route, and it is deliberately ONE implementation: the Payment Requests page
// now calls it too, rather than keeping the copy it used to own.
//
// NOTHING HERE IS A NEW RULE, AND NOTHING HERE IS AUTHORITY
// ---------------------------------------------------------
// Every protection this action relies on is already in the database and is
// untouched by it:
//
//   finance_payment_requests_guard_approved_delete (20260705000000)
//     BEFORE DELETE, no admin exemption and no service-role exemption. A
//     verified payment raises PAYMENT_APPROVED_PERMANENT and the transaction
//     ends. This is what makes "confirmed money is permanent" true rather than
//     merely intended, and it is the reason the checks in this module are a
//     courtesy to the reader rather than the thing standing in the way.
//
//   finance_payment_requests_release_allocations (20260918000000 §8a)
//     BEFORE DELETE, named so it sorts AFTER the guard (g < r), so a verified
//     payment is refused before anything is released. It deletes the payment's
//     allocations in the same statement as the payment, which is why this
//     module never touches finance_payment_allocations itself: the release is
//     atomic with the delete or it does not happen at all.
//
//   payment_proof_attachments / finance_payment_request_activity_log
//     ON DELETE CASCADE (20260672, 20260674). The rows go with the payment.
//
//   finance_payment_requests_own_delete / _admin_delete (20260700000000, 20260654)
//     Row-level security. The creator may delete their own row in the three
//     unapproved statuses; an administrator may delete any row the guard above
//     allows. THERE IS NO FINANCE-PERMISSION DELETE POLICY, and this module does
//     not invent one — see canDeletePayment.
//
// WHAT IS LEFT FOR THE APPLICATION is the one thing Postgres cannot do: the
// proof object in the payment-proofs bucket, which no cascade reaches.

import type { SupabaseClient } from '@supabase/supabase-js'
import { PROOF_BUCKET } from '@/lib/paymentProof'
import { REQUEST_STAGE_STATUSES } from '@/app/finance/paymentRouting'

/**
 * The statuses a payment may be deleted from.
 *
 * NOT A SECOND DEFINITION. It is REQUEST_STAGE_STATUSES — the same three the
 * Payment Requests page has always scoped its mutations to, and the same three
 * named by finance_payment_requests_own_delete. Their relationship to the
 * canonical verified pair is asserted rather than assumed: the assertion suite
 * checks this list is exactly the payment status CHECK constraint minus
 * everything finance_payment_status_is_verified() calls verified, so a sixth
 * status added to the constraint tomorrow cannot quietly become deletable and a
 * verified one cannot quietly stop being protected.
 */
export const DELETABLE_PAYMENT_STATUSES = REQUEST_STAGE_STATUSES

export function isPaymentDeletableStatus(status: string | null | undefined): boolean {
  return (DELETABLE_PAYMENT_STATUSES as readonly string[]).includes(status ?? '')
}

/**
 * Who may delete this payment — as the DATABASE already answers it.
 *
 * ADMIN, OR THE PERSON WHO RAISED IT. Those are the two DELETE policies that
 * exist, so those are the two cases where offering the control leads anywhere.
 *
 * A FINANCE MANAGER WHO IS NEITHER IS NOT OFFERED IT, and that is a finding
 * rather than an oversight: no policy grants DELETE on finance_payment_requests
 * by Finance permission, so a button shown to them would produce a delete that
 * matches zero rows and reports the payment as already verified — the least
 * true message available. Widening that grant is a database change and a
 * deliberate business decision, not something to slip in behind a button.
 *
 * THIS DECIDES VISIBILITY, NEVER PERMISSION. Row-level security re-derives the
 * actor, and the guard trigger re-derives the status, against the committed row
 * at the moment of the DELETE.
 */
export function canDeletePayment(
  payment: { status: string; submitted_by?: string | null },
  actor: { isAdmin: boolean; userId: string | null | undefined },
): boolean {
  if (!isPaymentDeletableStatus(payment.status)) return false
  if (actor.isAdmin) return true
  return !!actor.userId && payment.submitted_by === actor.userId
}

/** Shown when the DELETE matched zero rows: verified while the modal was open. */
export const PAYMENT_DELETE_RACE_MESSAGE =
  'This payment has already been verified and can no longer be deleted.'

/** Shown when the proof attachments could not be read, before anything ran. */
export const PAYMENT_DELETE_PROOF_READ_MESSAGE =
  'Could not read this payment’s proof attachments. Nothing was deleted — please try again.'

export const PAYMENT_DELETE_ALLOCATION_WARNING =
  'Any allocations of this payment to an Order or a PI Draft are removed with it.'

export const PAYMENT_DELETE_CONFIRM_LABEL = 'Delete Payment'
export const PAYMENT_DELETE_BUSY_LABEL    = 'Deleting…'
export const PAYMENT_DELETE_TITLE         = 'Delete Payment'

export type PaymentDeletionResult =
  /** Gone, proof and all. */
  | { outcome: 'deleted' }
  /**
   * The payment is gone and its proof object is not. Reported rather than
   * swallowed, and NOT retryable: the row the storage policy resolved ownership
   * through no longer exists, so pressing again cannot help.
   */
  | { outcome: 'proof-orphaned'; message: string }
  /** Nothing was deleted, and the state on screen is stale. */
  | { outcome: 'already-verified'; message: string }
  /** Nothing was deleted. */
  | { outcome: 'failed'; message: string }

export type DeletablePayment = {
  id: string
  request_number?: string | null
  status: string
}

/**
 * Delete one payment entry and clean up after it.
 *
 * THE ORDER IS LOAD-BEARING, and it is the order the Payment Requests page has
 * used since 20260700000000:
 *
 *   1. READ THE PROOF PATHS FIRST. payment_proof_attachments cascades with the
 *      payment, so after the delete there is nothing left to read them from.
 *      Only this payment's own attachments are collected, and the paths come
 *      from the database — never from the browser, which has no business naming
 *      an object for the server to remove.
 *
 *   2. DELETE THE PAYMENT, FILTERED ON STATUS. Row-level security and the guard
 *      trigger both re-evaluate against the committed row, so a verification
 *      landing while the dialog was open makes this a zero-row no-op instead of
 *      destroying confirmed bank history. The allocations are released by the
 *      trigger inside this same statement; this function never writes to
 *      finance_payment_allocations, because a release that is not atomic with
 *      the delete is a release that can be left half-done.
 *
 *   3. REMOVE THE NOW-ORPHANED PROOF OBJECTS. The payment goes FIRST on purpose:
 *      removing the file first would destroy the evidence for a payment that
 *      then turned out to be un-deletable.
 *
 * IDEMPOTENT AT BOTH ENDS. A payment that is already gone matches zero rows —
 * reported as 'already-verified' only when the row still exists, and callers
 * that re-read the list find it absent either way. A proof key already removed
 * is simply not there to remove again.
 */
export async function deletePaymentEntry(
  supabase: SupabaseClient,
  payment: DeletablePayment,
  describeError: (error: { code?: string; message: string }) => string,
): Promise<PaymentDeletionResult> {
  const { data: proofs, error: proofErr } = await supabase
    .from('payment_proof_attachments')
    .select('storage_path')
    .eq('payment_request_id', payment.id)
  if (proofErr) {
    return { outcome: 'failed', message: PAYMENT_DELETE_PROOF_READ_MESSAGE }
  }

  const { error: dbError, count } = await supabase
    .from('finance_payment_requests')
    .delete({ count: 'exact' })
    .eq('id', payment.id)
    .in('status', DELETABLE_PAYMENT_STATUSES)
  if (dbError) {
    return { outcome: 'failed', message: describeError(dbError) }
  }
  if (count === 0) {
    return { outcome: 'already-verified', message: PAYMENT_DELETE_RACE_MESSAGE }
  }

  const paths = ((proofs ?? []) as { storage_path: string }[])
    .map(proof => proof.storage_path)
    .filter(Boolean)
  if (paths.length > 0) {
    const { data: removed, error: rmErr } = await supabase.storage.from(PROOF_BUCKET).remove(paths)
    if (rmErr || (removed?.length ?? 0) < paths.length) {
      const name = payment.request_number ? `Payment ${payment.request_number}` : 'The payment'
      return {
        outcome: 'proof-orphaned',
        message: `${name} was deleted, but its proof file could not be removed from storage.`
          + ' Please ask an admin to delete it from the payment-proofs bucket.',
      }
    }
  }

  return { outcome: 'deleted' }
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
