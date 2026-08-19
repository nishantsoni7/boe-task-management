import type { EffectivePermission } from './types'

// Finance capability derivation.
//
// One place that turns the raw effective permissions for the 'finance' module
// into the booleans the pages branch on, so the UI and the database say the
// same thing. Same shape as assetsAccess.ts and meetings.ts.
//
// NOT YET WIRED. src/app/finance/page.tsx and
// src/app/finance/received/ReceivedPaymentsView.tsx still derive a single
// `isAdmin` from users.role and gate every administrative control on it, which
// is why an employee holding a full Finance grant sees a read-only Finance.
// Connecting this file to those pages — and adding the matching server-side
// checks — is a separate step; nothing here changes Finance behaviour today.
//
// The action a capability maps to, and the control it governs:
//
//   view     → open /finance at all
//   create   → raise a payment request
//   edit     → change an unapproved request (alongside the existing "own
//              request" rule, which is ownership, not permission)
//   approve  → approve or reject a pending payment request
//   export   → download the finance registers
//   manage   → correct or reverse a recorded payment, and link/unlink an order
//   delete   → remove a payment request
//   allocate → decide which PI submission or Order a verified payment belongs to
//   allocate_correct
//            → reverse an allocation that has already been recorded
//
// `manage`, `delete`, `allocate` and `allocate_correct` are PROTECTED (see
// levels.ts): no access level grants them, they are ticked individually or not
// at all. That is deliberate — correcting a recorded payment rewrites a
// financial fact, and none of them is something an administrator should acquire
// as a side effect of picking "Manager" from a dropdown.
//
// `approve` is NOT renamed and NOT re-scoped by the allocation phase. It remains
// the authority to confirm that money arrived — what the product calls payment
// VERIFICATION — and it is deliberately independent of both allocation actions
// in every direction: verifying that money came in, deciding which business it
// belongs to, and undoing that decision are three separable jobs.

export type FinanceCapabilities = {
  /** May open Finance at all. Says nothing about which records are visible. */
  canAccessFinanceModule: boolean
  /**
   * May see EVERY payment record in the company, not only their own and the
   * ones their order participation already allows. Backed by the protected
   * `view_all` action and the RLS policies 20260903000000 adds.
   *
   * Read-only by construction: it implies no create, edit, approve, manage,
   * delete or export, and holding orders.view_all does not confer it.
   */
  canViewAllFinance: boolean
  /** May raise a new payment request. */
  canCreatePaymentRecord: boolean
  /**
   * May edit a payment record they are permitted to act on. Ownership and
   * status are separate questions, still answered by canManageRequest in the
   * Finance page — this only says whether the permission exists.
   */
  canEditPaymentRecord: boolean
  /** May approve or reject a pending payment request. */
  canApprovePayment: boolean
  canExportFinance: boolean
  /**
   * May correct or reverse a recorded payment, and link or unlink an order.
   * Rewrites a financial fact that has already been reported.
   */
  canCorrectOrReversePayment: boolean
  canDeletePaymentRecord: boolean
  /**
   * May allocate part or all of a VERIFIED payment to a PI submission or a
   * Confirmed Order. Backed by the protected `allocate` action, which
   * 20260918000000 registers, and required by allocate_payment_to_target() in
   * the database — so a control drawn from this matches what the RPC will allow.
   *
   * Says nothing about verifying a payment (that is `approve`) and nothing about
   * undoing an allocation (that is `allocate_correct`). Holding it confers no
   * additional visibility of any payment, PI or Order.
   */
  canAllocatePayment: boolean
  /**
   * May REVERSE an allocation that has already been recorded. Backed by the
   * protected `allocate_correct` action and required by
   * reverse_payment_allocation().
   *
   * INDEPENDENT OF canAllocatePayment IN BOTH DIRECTIONS, deliberately: creating
   * an allocation and rewriting one that has already been reported are different
   * authorities, and the business has chosen to keep them assignable to
   * different people. An allocation is never deleted — reversal keeps the row,
   * its actor, its time and its reason.
   */
  canCorrectPaymentAllocation: boolean
  /**
   * Full administrative control of the module. Backed by the same 'manage'
   * action as canCorrectOrReversePayment today; kept as its own name because
   * the two gate different controls and may well be split into separate
   * actions later, exactly as Assets split 'assign' out of 'manage' in
   * migration 20260725000000.
   */
  canManageFinance: boolean
}

export const NO_FINANCE_CAPABILITIES: FinanceCapabilities = {
  canAccessFinanceModule: false,
  canViewAllFinance: false,
  canCreatePaymentRecord: false,
  canEditPaymentRecord: false,
  canApprovePayment: false,
  canExportFinance: false,
  canCorrectOrReversePayment: false,
  canDeletePaymentRecord: false,
  canAllocatePayment: false,
  canCorrectPaymentAllocation: false,
  canManageFinance: false,
}

export function deriveFinanceCapabilities(
  role: string | null | undefined,
  permissions: readonly EffectivePermission[],
): FinanceCapabilities {
  if (role === 'admin') {
    return {
      canAccessFinanceModule: true,
      // Admins already match finance_payment_requests_admin_select, which
      // 20260903000000 does not touch.
      canViewAllFinance: true,
      canCreatePaymentRecord: true,
      canEditPaymentRecord: true,
      canApprovePayment: true,
      canExportFinance: true,
      canCorrectOrReversePayment: true,
      canDeletePaymentRecord: true,
      // The project's established admin bypass, and the same one
      // actor_has_module_permission applies in the database — so the UI and the
      // two allocation RPCs agree about an administrator.
      canAllocatePayment: true,
      canCorrectPaymentAllocation: true,
      canManageFinance: true,
    }
  }

  const allowed = (actionKey: string) =>
    permissions.some(p => p.actionKey === actionKey && p.allowed)

  // Entry requires 'view' and nothing else. Unlike assetsAccess.ts and
  // meetings.ts, a stronger action does NOT imply entry here: Finance has not
  // cut over yet, so it starts on the V1 rule where visibility is one readable
  // fact and preset writes are normalized to include 'view'. See
  // moduleVisibility.ts.
  const canAccessFinanceModule = allowed('view')

  // Every capability is gated on entry as well as on its own action, so a row
  // left behind by a half-finished grant cannot produce a button on a module
  // the person cannot open.
  const withEntry = (actionKey: string) => canAccessFinanceModule && allowed(actionKey)

  return {
    canAccessFinanceModule,
    canViewAllFinance: withEntry('view_all'),
    canCreatePaymentRecord: withEntry('create'),
    canEditPaymentRecord: withEntry('edit'),
    canApprovePayment: withEntry('approve'),
    canExportFinance: withEntry('export'),
    canCorrectOrReversePayment: withEntry('manage'),
    canDeletePaymentRecord: withEntry('delete'),
    canAllocatePayment: withEntry('allocate'),
    canCorrectPaymentAllocation: withEntry('allocate_correct'),
    canManageFinance: withEntry('manage'),
  }
}
