// Who gets the salesperson's Payment Requests list (no Status, no Requested By).
//
// A Finance REVIEWER is someone who can decide a payment: an admin, or a holder
// of finance.approve (which the Manager level carries). Everything else is a
// salesperson for this list — including someone with finance.view_all.
//
// view_all is the protected, individually-ticked, READ-ONLY company-wide sight
// (levels.ts PROTECTED_ACTIONS; "implies no create, edit, approve, manage, delete
// or export"). It lets a person see other people's requests; it gives them no
// decision to make, so it is not evidence that they review. Nor are manage,
// allocate or delete: they act on payments that are already decided, not on this
// queue. The review columns exist for the one job the queue has — deciding.

import type { FinanceCapabilities } from '@/lib/permissions/finance'

export function isSalespersonPaymentView(
  isAdmin: boolean,
  caps: Pick<FinanceCapabilities, 'canApprovePayment'>,
): boolean {
  return !isAdmin && !caps.canApprovePayment
}
