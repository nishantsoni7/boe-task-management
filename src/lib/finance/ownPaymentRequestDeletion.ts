// A salesperson deleting their OWN unapproved payment request.
//
// NOT the admin deletion in ./paymentDeletion (a hard delete through the durable
// claim protocol, for any status, with a reason and a typed Payment ID). This is
// a soft delete — delete_own_payment_request, 20270226000000 — that keeps the
// row, its trail and its (reversed) allocations, and refuses anything that was
// ever approved.
//
// EVERYTHING HERE DECIDES VISIBILITY, NEVER PERMISSION. The RPC re-derives the
// caller, the owner, the status and the approval history under a row lock; a
// request approved while the confirmation dialog was open is refused there.

import type { createClient } from '@/lib/supabase/client'
import { REQUEST_STAGE_STATUSES } from '@/app/finance/paymentRouting'

export const OWN_DELETE_TITLE = 'Delete payment request?'
export const OWN_DELETE_MESSAGE = 'This request will be removed from the payment request list.'
export const OWN_DELETE_CONFIRM_LABEL = 'Delete request'
export const OWN_DELETE_BUSY_LABEL = 'Deleting…'
export const OWN_DELETE_CANCEL_LABEL = 'Cancel'

/**
 * Whether to offer Delete on this row: the signed-in person raised it and it is
 * still at request stage (Pending, Needs Clarification, Rejected — Archive is a
 * view of old rejected rows). "Never approved" is the database's call; a row the
 * list shows as rejected may still have an approval in its history.
 */
export function canDeleteOwnPaymentRequest(
  payment: { status: string; submitted_by: string },
  userId: string | null | undefined,
): boolean {
  if (!userId || payment.submitted_by !== userId) return false
  return (REQUEST_STAGE_STATUSES as readonly string[]).includes(payment.status)
}

export type OwnDeleteResult =
  | { outcome: 'success'; alreadyDeleted: boolean }
  | { outcome: 'failure'; message: string }

const FAILURE_MESSAGES: Array<[RegExp, string]> = [
  [/PAYMENT_APPROVED/, 'This payment has been approved, so it can no longer be deleted.'],
  [/PAYMENT_NOT_OWNER/, 'Only the person who raised this request can delete it.'],
  [/PAYMENT_NOT_FOUND/, 'This request could not be found. It may already have been removed.'],
  [/PAYMENT_REQUEST_DELETED/, 'This request has already been deleted.'],
  [/PAYMENT_UNAUTHENTICATED/, 'Your session has ended. Sign in again and retry.'],
]

/** What to tell the person, from whatever the database or the network said. */
export function describeOwnDeleteFailure(error: { message?: string } | null | undefined): string {
  const text = error?.message ?? ''
  for (const [pattern, message] of FAILURE_MESSAGES) if (pattern.test(text)) return message
  return 'The request could not be deleted. Nothing was changed. Please try again.'
}

export async function deleteOwnPaymentRequest(
  supabase: ReturnType<typeof createClient>,
  paymentId: string,
): Promise<OwnDeleteResult> {
  try {
    const { data, error } = await supabase.rpc('delete_own_payment_request', { p_payment_id: paymentId })
    if (error) return { outcome: 'failure', message: describeOwnDeleteFailure(error) }
    const body = (data ?? {}) as { already_deleted?: boolean }
    return { outcome: 'success', alreadyDeleted: body.already_deleted === true }
  } catch {
    return { outcome: 'failure', message: describeOwnDeleteFailure(null) }
  }
}
