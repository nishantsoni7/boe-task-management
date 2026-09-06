import type { EffectivePermission } from './types'

// Order Management capability derivation.
//
// One place that turns the raw effective permissions for the 'orders' module
// into the booleans the pages branch on. Same shape as assetsAccess.ts,
// meetings.ts and finance.ts.
//
// The action a capability maps to:
//
//   view                        → open /orders
//   create                      → upload a PI and start a new order
//   edit                        → change an order or a PI Draft (alongside the
//                                 existing ownership rules, which are ownership,
//                                 not permission)
//   approve_order               → review and approve an imported PI submission
//   approve_advance_exception   → decide an advance exception on a submitted PI
//   export                      → download the order registers
//   delete                      → remove a record
//   manage                      → administrative control across the module
//   view_all                    → see every order in the company
//
// TWO CAPABILITIES WERE REMOVED WHEN THE ORDER REQUEST WORKFLOW WAS RETIRED.
// `canApproveOrder` (the `approve` action) meant "convert an Order Request into
// an Order", and `canBeOrderAssignee` meant "may be named as an Order Request
// assignee". Both are now Access Control options that grant nothing — the RPCs
// that read them are revoked from every client role by 20261007000000 §4, and
// the database refuses the writes they would attempt — so they are no longer
// registered, derived or offered. See modules.ts for why a grant that confers
// nothing is worse than no option at all.
//
// `delete` and `manage` remain PROTECTED (see levels.ts).

export type OrdersCapabilities = {
  /** May open Order Management at all. Says nothing about which orders are visible. */
  canAccessOrdersModule: boolean
  /**
   * May see EVERY order in the company, not only the ones the ownership rules
   * allow. Backed by the protected `view_all` action and by the RLS policies
   * 20260903000000 repoints at it.
   *
   * Says nothing about acting on those orders, and nothing about Finance: it
   * reveals no price, payment, payment summary or finance record. Those stay
   * behind finance.view_all and the Finance policies.
   */
  canViewAllOrders: boolean
  canCreateOrder: boolean
  /**
   * May edit an order or a PI Draft they are permitted to act on. WHICH records
   * is still decided by the existing ownership rules and by RLS.
   */
  canEditOrder: boolean
  /**
   * Review an imported PI submission — send it back for changes, reject it, and
   * approve it into a numbered Order. Backed by the protected `approve_order`
   * action, which 20260908000000 registers.
   *
   * THE ONLY APPROVAL AUTHORITY IN THE PRE-ORDER WORKFLOW, now that Order
   * Request conversion is retired. It was deliberately never the plain `approve`
   * action, which is exactly why the retirement takes nothing away from anybody
   * holding this one.
   */
  canApproveOrderSubmission: boolean
  /**
   * Decide an ADVANCE EXCEPTION on a submitted PI — accept or refuse a proposed
   * advance below the standard 40%, zero included. Backed by the protected
   * `approve_advance_exception` action, which 20260913000000 registers.
   *
   * INDEPENDENT OF canApproveOrderSubmission IN BOTH DIRECTIONS. Reviewing a PI
   * and settling its commercial terms are two decisions on the same record, and
   * the business has chosen to keep them assignable to different people:
   *
   *   approve_order only              may send back and reject, may NOT decide
   *                                   an advance exception
   *   approve_advance_exception only  may decide the exception, may NOT approve,
   *                                   reject or return the PI, gains no order
   *                                   visibility, no Finance sight and no
   *                                   payment access
   *
   * approve_pi_advance_exception() and reject_pi_advance_exception() require
   * exactly this action in the database, so a control drawn from it matches what
   * the RPC will allow.
   */
  canApproveAdvanceException: boolean
  /**
   * Align a Confirmed Order for production, or take that alignment back.
   * Backed by the protected `align_production` action, which 20261116000000
   * registers, and required by set_order_production_alignment() in the
   * database. Independent of every other capability here: it is the Head of
   * Manufacturing's decision, not a reviewer's and not a manager's.
   */
  canAlignProduction: boolean
  canExportOrders: boolean
  canDeleteOrder: boolean
  /** Administrative control of the module. */
  canManageOrders: boolean
}

export const NO_ORDERS_CAPABILITIES: OrdersCapabilities = {
  canAccessOrdersModule: false,
  canViewAllOrders: false,
  canCreateOrder: false,
  canEditOrder: false,
  canApproveOrderSubmission: false,
  canApproveAdvanceException: false,
  canAlignProduction: false,
  canExportOrders: false,
  canDeleteOrder: false,
  canManageOrders: false,
}

export function deriveOrdersCapabilities(
  role: string | null | undefined,
  permissions: readonly EffectivePermission[],
): OrdersCapabilities {
  const allowed = (actionKey: string) =>
    permissions.some(p => p.actionKey === actionKey && p.allowed)

  if (role === 'admin') {
    return {
      canAccessOrdersModule: true,
      // An admin already sees every order through orders_admin_select, which
      // 20260903000000 leaves untouched. Reported as true so the UI matches
      // what the database does rather than resolving a grant admins don't need.
      canViewAllOrders: true,
      canCreateOrder: true,
      canEditOrder: true,
      canApproveOrderSubmission: true,
      // An active admin decides advance exceptions without an explicit grant,
      // exactly as actor_has_module_permission's admin branch does in the
      // database. Reported true so the screen matches the RPC.
      canApproveAdvanceException: true,
      // The same admin branch set_order_production_alignment() takes.
      canAlignProduction: true,
      canExportOrders: true,
      canDeleteOrder: true,
      canManageOrders: true,
    }
  }

  // Entry requires 'view'. See the note in finance.ts and moduleVisibility.ts.
  const canAccessOrdersModule = allowed('view')
  const withEntry = (actionKey: string) => canAccessOrdersModule && allowed(actionKey)

  return {
    canAccessOrdersModule,
    canViewAllOrders: withEntry('view_all'),
    canCreateOrder: withEntry('create'),
    canEditOrder: withEntry('edit'),
    canApproveOrderSubmission: withEntry('approve_order'),
    // Resolved from its OWN action. approve_order does not imply it, and it
    // does not imply approve_order.
    canApproveAdvanceException: withEntry('approve_advance_exception'),
    canAlignProduction: withEntry('align_production'),
    canExportOrders: withEntry('export'),
    canDeleteOrder: withEntry('delete'),
    canManageOrders: withEntry('manage'),
  }
}
