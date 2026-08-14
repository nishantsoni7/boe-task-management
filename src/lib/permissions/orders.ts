import type { EffectivePermission } from './types'

// Order Management capability derivation.
//
// One place that turns the raw effective permissions for the 'orders' module
// into the booleans the pages branch on. Same shape as assetsAccess.ts,
// meetings.ts and finance.ts.
//
// PARTIALLY WIRED TODAY, and that gap is the point. src/app/orders/layout.tsx
// already honours resolve_permission('orders','view') for module entry, so a
// grant really does open the route. Everything INSIDE then re-derives a single
// `isAdmin` from users.role — src/app/orders/page.tsx:224,
// src/app/orders/requests/page.tsx:1839,
// src/app/orders/requests/[id]/page.tsx:822 — so create/edit/delete/approve/
// export/manage grants are saved, resolved, and checked nowhere. Connecting
// this file to those pages, with matching server-side checks, is a separate
// step; nothing here changes Orders behaviour today.
//
// The action a capability maps to:
//
//   view                   → open /orders and /orders/requests
//   create                 → raise an order request
//   edit                   → change an order or request (alongside the existing
//                            "admin OR assigned_to" ownership rule in
//                            src/app/orders/requests/components/shared.ts,
//                            which is ownership, not permission)
//   approve                → approve an order request
//   export                 → download the order registers
//   delete                 → remove an order request
//   manage                 → administrative control across the module
//   can_be_order_assignee  → eligible to be NAMED as an Order Request assignee
//
// `delete`, `manage` and `can_be_order_assignee` are PROTECTED (see levels.ts).
// The last of those is the strictest: migration 20260697000000 grants it only
// through employee_permission_overrides for named exceptions, never through
// role_permissions, so that it can never broaden to every admin/manager/
// operations/bdm employee. A preset must not reach it either.

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
   * May edit an order or request they are permitted to act on. WHICH records
   * is still decided by the existing assignment rule and by RLS.
   */
  canEditOrder: boolean
  canApproveOrder: boolean
  canExportOrders: boolean
  canDeleteOrder: boolean
  /** Administrative control of the module. */
  canManageOrders: boolean
  /**
   * May be selected as an Order Request assignee. Not an action this person
   * performs — an eligibility other people's forms read. Per-employee only.
   */
  canBeOrderAssignee: boolean
}

export const NO_ORDERS_CAPABILITIES: OrdersCapabilities = {
  canAccessOrdersModule: false,
  canViewAllOrders: false,
  canCreateOrder: false,
  canEditOrder: false,
  canApproveOrder: false,
  canExportOrders: false,
  canDeleteOrder: false,
  canManageOrders: false,
  canBeOrderAssignee: false,
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
      canApproveOrder: true,
      canExportOrders: true,
      canDeleteOrder: true,
      canManageOrders: true,
      // Assignee eligibility is NOT implied by being an admin. It is a named
      // list that other people's dropdowns read, and 20260697000000 exists
      // precisely so that it does not broaden to every admin. Resolved from
      // the grant even here.
      canBeOrderAssignee: allowed('can_be_order_assignee'),
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
    canApproveOrder: withEntry('approve'),
    canExportOrders: withEntry('export'),
    canDeleteOrder: withEntry('delete'),
    canManageOrders: withEntry('manage'),
    // Deliberately NOT gated on module entry: eligibility to be named on a
    // request is a property of the person, read by somebody else's form. An
    // employee can be a valid assignee without holding the Orders module
    // themselves, which is the case 20260699000000 already supports.
    canBeOrderAssignee: allowed('can_be_order_assignee'),
  }
}
