// What the permission engine ACTUALLY decides, per module.
//
// The Access Control screen tells an administrator whether the permissions they
// are about to save will do anything. That claim has to be true, because the
// alternative is the failure this project has already hit once: on 2026-07-16
// ten employees were granted create/edit on Assets & Access while nothing
// consulted the engine, the grants looked real, and migration 20260721000000
// then made them live all at once — see 20260723000000, which exists to undo
// it.
//
// A single enforced/not-enforced flag cannot state the truth here, because two
// modules are enforced only in part. `orders` honours the engine for module
// ENTRY and for assignee eligibility while every other action is still decided
// by users.role; saying "Active" there would tell an administrator that ticking
// Approve does something. It does not.
//
// Each entry below is grounded in code that was read, not inferred from a
// module's maturity. When a module cuts over, update it here — this is the one
// place that answers the question.

export type EnforcementState =
  /** Every action this module registers is checked by app code, RLS, or an RPC. */
  | 'enforced'
  /** Some actions are checked; the rest are stored but decide nothing. */
  | 'partial'
  /** Saved and resolvable, but no code path consults them yet. */
  | 'prepared'
  /** Not used at all: the module is governed by the admin role by design. */
  | 'role_only'

export type ModuleEnforcement = {
  state: EnforcementState
  /** For `partial`, the actions that really are checked. */
  enforcedActions?: readonly string[]
  /** One sentence an administrator can act on. */
  detail: string
}

export const MODULE_ENFORCEMENT: Record<string, ModuleEnforcement> = {
  // RLS on assets / employee_assets (20260721000000, corrected 20260723000000),
  // the custody RPCs via assert_asset_custody_permission (20260725000000), the
  // own-records boundary (20260810000000), and the capability derivation in
  // src/lib/permissions/assetsAccess.ts, which AssetsLayout gates the screen on.
  assets_access: {
    state: 'enforced',
    detail: 'Every action is enforced — in the database and in the screen.',
  },

  // RLS via can_view_meeting() / can_edit_meeting() (20260814000000), the
  // import and template routes, and src/lib/permissions/meetings.ts.
  meetings: {
    state: 'enforced',
    detail: 'Every action is enforced — in the database and in the screen.',
  },

  // sample_dispatches RLS resolves the four lifecycle actions
  // (20260665_cutover_sample_tracking_rls_to_resolver.sql) and the Sample
  // Tracking screen resolves 'view'. create/edit/delete/approve/export/manage
  // are registered for completeness and are not checked anywhere.
  sample_tracking: {
    state: 'partial',
    enforcedActions: ['view', 'dispatch', 'receive', 'mark_lost', 'close'],
    detail: 'View and the dispatch/receive/mark-lost/close actions are enforced. The others are saved but not yet used.',
  },

  // 'view' via src/app/orders/layout.tsx and the launcher; assignee
  // eligibility via 20260697000000. The three protected actions were added by
  // 20260901000000_finance_orders_permission_enforcement.sql:
  //   approve → convert_order_request_to_order, reject_order_request,
  //             request_order_request_clarification
  //   manage  → assert_order_amender, the choke point for amend_order and
  //             cancel_order
  //   delete  → admin_delete_order_request, plus the delete API route
  // create/edit stay on the existing admin-or-assigned ownership rule.
  orders: {
    state: 'partial',
    enforcedActions: ['view', 'approve', 'manage', 'delete', 'can_be_order_assignee'],
    detail: 'Opening the module, approving, managing, deleting and assignee eligibility are enforced. Create and edit still follow the admin-or-assigned rule.',
  },

  // Cut over by the same migration:
  //   approve → approve_finance_payment_request(), plus the reject/clarify
  //             UPDATE policy
  //   manage  → the four link/unlink RPCs, the correction UPDATE policy, and
  //             the post-approval guard trigger's exemption
  //   delete  → the unapproved-delete policy
  // view/create/edit remain ownership-based on purpose — see section 5 of that
  // migration.
  //
  // PREREQUISITE for both entries above: the claims hold only once
  // 20260901000000 is APPLIED. The screens already resolve these capabilities,
  // so shipping the frontend ahead of the migration would offer controls the
  // database still refuses.
  finance: {
    state: 'partial',
    enforcedActions: ['approve', 'manage', 'delete'],
    detail: 'Approve, correct/reverse and delete are enforced. View, create and edit still follow record ownership.',
  },

  // Management Attendance and Payroll read the whole company and are admin-only
  // by an explicit product decision, enforced by resolveManagementAccess and by
  // the /api/attendance and /api/payroll routes. No grant here can open them,
  // and none is intended to. Self-service (/my-attendance, /my-payroll) is a
  // separate surface that does not consult this module at all.
  attendance: {
    state: 'role_only',
    detail: 'Not used. Attendance management is admin-only, and these permissions cannot grant it.',
  },
  payroll: {
    state: 'role_only',
    detail: 'Not used. Payroll management is admin-only, and these permissions cannot grant it.',
  },
}

const DEFAULT_ENFORCEMENT: ModuleEnforcement = {
  state: 'prepared',
  detail: 'Saved but not yet used in this module.',
}

export function moduleEnforcement(moduleKey: string): ModuleEnforcement {
  return MODULE_ENFORCEMENT[moduleKey] ?? DEFAULT_ENFORCEMENT
}

/** Short badge text. Deliberately never says "Active" for a partial module. */
export const ENFORCEMENT_BADGE_LABEL: Record<EnforcementState, string> = {
  enforced: 'Active',
  partial: 'Partly active',
  prepared: 'Prepared',
  role_only: 'Not used',
}

/** Whether a specific action is checked anywhere today. */
export function isActionEnforced(moduleKey: string, actionKey: string): boolean {
  const enforcement = moduleEnforcement(moduleKey)
  if (enforcement.state === 'enforced') return true
  if (enforcement.state === 'partial') return !!enforcement.enforcedActions?.includes(actionKey)
  return false
}
