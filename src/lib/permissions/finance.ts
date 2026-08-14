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
//
// `manage` and `delete` are PROTECTED (see levels.ts): no access level grants
// them, they are ticked individually or not at all. That is deliberate —
// correcting a recorded payment rewrites a financial fact, and neither is
// something an administrator should acquire as a side effect of picking
// "Manager" from a dropdown.

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
    canManageFinance: withEntry('manage'),
  }
}
