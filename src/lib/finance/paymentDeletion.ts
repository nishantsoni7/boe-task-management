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
// proof object in the payment-proofs bucket, which no cascade reaches. That is
// exactly why this build does not delete anything — see deletePaymentEntry.

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

/**
 * Shown on every attempt: this build refuses to delete any unapproved payment.
 *
 * WHY EVERY PAYMENT, NOT JUST THE ONES WITH PROOFS ON SCREEN. The version this
 * replaces read the attachment count in one round trip and issued the DELETE in
 * a second one. A proof uploaded in the gap between those two calls is a proof
 * whose payment_proof_attachments row is then cascaded away by the DELETE the
 * count call decided was safe — the row naming that object is destroyed in the
 * same statement that destroys the payment, and nothing is left that can say
 * which object in the bucket used to belong to it. That is an orphan with no
 * durable record, and no later attempt can find it, let alone retry it. An
 * "apparently zero-proof" payment is not a safe case; it is a payment whose
 * proof count was merely not yet nonzero at the moment it was read.
 *
 * NO EXISTING DATABASE OBJECT CLOSES THIS. payment_proof_attachments does carry
 * a foreign key to finance_payment_requests, which is real locking — but nothing
 * already applied exposes "check for attachments and delete" as one atomic
 * statement a client can call, and adding one is a migration, not an
 * application change. Manufacturing that mechanism here — on a branch that must
 * not gain a migration to keep a feature — would be inventing exactly the kind
 * of unsafe workaround this message exists to avoid.
 *
 * So this build does not attempt the delete at all: no SELECT of the attachment
 * count, no DELETE of the payment row, no storage call. The button stays, so an
 * operator is not left wondering whether the capability exists; pressing it
 * explains why it does not yet act, rather than acting unsafely. The durable
 * claim protocol that can delete a payment safely — proof-backed or not — is
 * migration 20261010000000 on the Order/Finance branch, which freezes proof
 * mutation for the duration of the delete instead of racing it.
 */
export const PAYMENT_DELETE_UNAVAILABLE_MESSAGE =
  'Safe deletion is not available for this payment in this version.'
  + ' It will be available in the next version. No data was removed.'

export const PAYMENT_DELETE_ALLOCATION_WARNING =
  'Any allocations of this payment to an Order or a PI Draft are removed with it.'

export const PAYMENT_DELETE_CONFIRM_LABEL = 'Delete Payment'
export const PAYMENT_DELETE_BUSY_LABEL    = 'Deleting…'
export const PAYMENT_DELETE_TITLE         = 'Delete Payment'

export type PaymentDeletionResult =
  /**
   * The only outcome this build has. Nothing was read, nothing was deleted, and
   * no storage call was made — see deletePaymentEntry.
   */
  { outcome: 'unavailable'; message: string }

export type DeletablePayment = {
  id: string
  request_number?: string | null
  status: string
}

/**
 * Delete one payment entry — refused, unconditionally, in this build.
 *
 * THIS USED TO BE A TWO-CALL SEQUENCE: read the attachment count, then delete
 * the payment if it read zero. Those are two round trips with no lock held
 * between them, so a proof inserted in the gap is cascaded away by the second
 * call along with the only row that named its storage object — an orphan with
 * no durable record, in a build that was supposed to guarantee none. See
 * PAYMENT_DELETE_UNAVAILABLE_MESSAGE for why nothing already in the database
 * closes that gap without a migration, and why this branch does not add one.
 *
 * SO NOTHING HERE TOUCHES SUPABASE. Not a read of payment_proof_attachments,
 * not a DELETE of the payment row, not a storage call — for a payment with
 * proofs or without, since without this call there is no way to tell which of
 * those a payment is at the instant it matters. Every caller still gets the
 * async, awaitable shape it always had, so the surfaces that call this need no
 * restructuring; they simply cannot make it delete anything until the durable
 * claim protocol (migration 20261010000000, on the Order/Finance branch) ships.
 */
export async function deletePaymentEntry(
  _supabase: SupabaseClient,
  _payment: DeletablePayment,
  _describeError: (error: { code?: string; message: string }) => string,
): Promise<PaymentDeletionResult> {
  return { outcome: 'unavailable', message: PAYMENT_DELETE_UNAVAILABLE_MESSAGE }
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
