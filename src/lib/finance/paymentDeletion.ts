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

/**
 * Shown when the payment has proof files and this build cannot delete it safely.
 *
 * THE OUTCOME THIS REPLACES WAS NOT SAFE. The first form of this module deleted
 * the payment row and then removed the proof objects, and reported a storage
 * failure as `proof-orphaned` — a "partial success". It was neither partial nor
 * a success. By the time storage was asked, the payment row and its
 * payment_proof_attachments rows had already cascaded away, so THE ONLY RECORD
 * OF WHICH OBJECTS BELONGED TO THAT PAYMENT WAS GONE. Nothing could retry it,
 * because nothing could still say what to retry. A file left in a private bucket
 * with no row naming it is not a settled outcome; it is a leak with a friendly
 * message attached.
 *
 * So this build does not attempt it. A payment with proofs is refused BEFORE
 * anything is deleted, and the durable claim protocol that can do it safely
 * arrives with migration 20261010000000 on the Order/Finance branch.
 */
export const PAYMENT_DELETE_PROOF_BACKED_MESSAGE =
  'This unapproved payment has proof files attached and cannot yet be deleted through this version.'
  + ' No data was removed.'

export const PAYMENT_DELETE_ALLOCATION_WARNING =
  'Any allocations of this payment to an Order or a PI Draft are removed with it.'

export const PAYMENT_DELETE_CONFIRM_LABEL = 'Delete Payment'
export const PAYMENT_DELETE_BUSY_LABEL    = 'Deleting…'
export const PAYMENT_DELETE_TITLE         = 'Delete Payment'

export type PaymentDeletionResult =
  /** Gone, with its allocations released by the trigger in the same statement. */
  | { outcome: 'deleted' }
  /**
   * The payment has proof files, and nothing was touched.
   *
   * NOT A PARTIAL ANYTHING. No row was deleted, no allocation released and no
   * storage request issued, so the payment is exactly as it was and the operator
   * can act on it through the protected flow once that ships.
   */
  | { outcome: 'proof-backed'; message: string }
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
 * Delete one payment entry — the zero-proof path, and only that.
 *
 * THE SEQUENCE THIS REPLACES DELETED FIRST AND ASKED STORAGE AFTERWARDS. That
 * order was chosen for a good reason — removing the file first would destroy the
 * evidence for a payment that then turns out to be un-deletable — but it bought
 * that safety with a worse one. `payment_proof_attachments` cascades with the
 * payment, so a storage failure arrived at a moment when the trusted manifest
 * naming those objects had ALREADY BEEN DESTROYED. There was nothing left to
 * retry from, and the module called that outcome a partial success.
 *
 * Deleting a row that owns files is therefore not a two-call operation at all.
 * It needs a durable claim: a record that outlives the payment, holds the frozen
 * list of object keys, and can be resumed by a later attempt. That protocol is
 * migration 20261010000000, which is NOT APPLIED, so this build cannot rely on
 * it and does not pretend to.
 *
 * WHAT IS LEFT IS STILL WORTH HAVING, and it is the case the stranded PI
 * actually needs: a payment with NO proof files has nothing in storage to lose,
 * so deleting it is one statement with no second system involved.
 *
 *   1. READ THE ATTACHMENTS, from the database, keyed by this payment's id — the
 *      browser names nothing. This is a fresh read taken immediately before the
 *      delete, not a value the screen was holding.
 *   2. IF THERE ARE ANY, REFUSE. No delete, no allocation release, no storage
 *      request. The payment is exactly as it was found.
 *   3. OTHERWISE DELETE, filtered on status. Row-level security and
 *      finance_payment_requests_guard_approved_delete both re-evaluate against
 *      the committed row, so a verification landing while the dialog was open is
 *      a zero-row no-op rather than destroyed bank history. The allocations are
 *      released by finance_payment_requests_release_allocations inside this same
 *      statement.
 *
 * NO STORAGE CALL IS MADE ON ANY PATH. There is nothing to remove when there
 * were no attachments, and nothing is deleted when there were.
 *
 * THE RESIDUAL WINDOW, STATED. A proof uploaded between step 1 and step 3 is
 * cascaded away by the delete and its object is left in the bucket. This build
 * cannot close that — closing it needs a claim that freezes proof mutation,
 * which is exactly what the pending migration adds. The window is one round trip
 * wide and requires an upload against a payment somebody is deleting at that
 * instant; the honest mitigation available here is to take the read as late as
 * possible, which is what step 1 is.
 *
 * IDEMPOTENT. A payment already gone matches zero rows; callers re-read the list
 * and find it absent either way.
 */
export async function deletePaymentEntry(
  supabase: SupabaseClient,
  payment: DeletablePayment,
  describeError: (error: { code?: string; message: string }) => string,
): Promise<PaymentDeletionResult> {
  const { count: proofCount, error: proofErr } = await supabase
    .from('payment_proof_attachments')
    .select('id', { count: 'exact', head: true })
    .eq('payment_request_id', payment.id)
  if (proofErr) {
    return { outcome: 'failed', message: PAYMENT_DELETE_PROOF_READ_MESSAGE }
  }
  if ((proofCount ?? 0) > 0) {
    return { outcome: 'proof-backed', message: PAYMENT_DELETE_PROOF_BACKED_MESSAGE }
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
