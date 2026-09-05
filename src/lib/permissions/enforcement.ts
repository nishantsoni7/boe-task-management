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
  // src/lib/permissions/assetsAccess.ts.
  //
  // MODULE ENTRY was the hole in this claim: deriveAssetsAccessCapabilities
  // computed canAccessAssetsModule and no page or layout ever read it, while
  // the launcher gated on app_modules ('live'). "Active" therefore overstated
  // coverage by exactly the parent gate. src/app/assets-access/layout.tsx now
  // supplies it, which is what makes this entry true rather than aspirational.
  //
  // `manage_access_records` (20261028000000) joins the list already enforced:
  // the three administrative policies on access_records read
  // can_manage_access_records(), the RESTRICTIVE module entry gate still stands
  // in front of them, and the screen reads the same answer through
  // deriveAssetsAccessCapabilities().canManageAccess.
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

  // Both actions this module registers are enforced in the database before they
  // are enforced anywhere else (20261017000000):
  //   use    → the route guard's resolve_permission call, the SELECT policy on
  //            customer_review_test_cards (through
  //            can_use_customer_review_test_cards()), the screenshot and
  //            storage policies, book_customer_review_test_card(), and the
  //            holder branch of transition_customer_review_test_card().
  //   verify → the verified/returned branch of that same transition function,
  //            and can_view_customer_review_test_card_row(), which is what lets
  //            a verifier read tests they did not run.
  // In the screen: src/app/customer-reviews/layout.tsx (entry), the launcher
  // card, and src/lib/permissions/customerReviewOutreach.ts.
  //
  // NOTE ON THE KEY. The module key is still `customer_review_requests` while
  // the tables are named for test cards. That is deliberate — the key is what
  // existing Control Center grants are written against — and it is stated here
  // because this file is where somebody tracing enforcement would notice the
  // mismatch and wonder whether it is a bug.
  //
  // PREREQUISITE: this claim holds once 20261017000000 is APPLIED. The module
  // is unreachable until then — the resolver returns no rows for an
  // unregistered module, so nobody resolves either action and the guard denies
  // everyone, administrators included.
  customer_review_requests: {
    state: 'enforced',
    detail: 'Every action is enforced — in the database and in the screen.',
  },
  // Both actions are enforced, and BOTH are checked server-side on every
  // generation. The Image Editor stores nothing, so it has no tables and
  // therefore no RESTRICTIVE parent gate from 20260905000000 to inherit; the
  // gate lives in src/lib/permissions/imageEditor.ts and in the two API routes
  // instead. That is why 'create' is never checked on its own here — the
  // dormant-child state (view off, create on) must grant nothing.
  //
  // Entry: src/app/image-editor/page.tsx via ModuleGuard.
  // Generation: POST /api/image-editor/studio, before the upload is read.
  // Download re-encode: POST /api/image-editor/convert, 'view' only — it
  // re-encodes an image the caller already holds and calls no provider.
  image_editor: {
    state: 'enforced',
    detail: 'Both actions are enforced in the screen and in the API. Use requires View.',
  },

  // sample_dispatches RLS resolves the four lifecycle actions
  // (20260665_cutover_sample_tracking_rls_to_resolver.sql).
  //
  // 'view' IS NOW ACTUALLY ENFORCED. Until this correction the entry here
  // claimed "the Sample Tracking screen resolves 'view'", and that was false:
  // /samples had no guard at all, the launcher gated on
  // app_modules.visibility_type ('live', therefore everyone), and the page
  // fetched sample_dispatches on mount. The false claim survived because —
  // unlike Orders, Finance, Meetings and Assets — nothing in enforcement.test.ts
  // asserted it against the source. There is a test now.
  //
  // Entry: src/app/samples/layout.tsx via ModuleGuard, plus the parent gate in
  // RLS from 20260904000000.
  //
  // create/edit/delete/approve/export/manage stay registered for completeness
  // and are still checked nowhere.
  sample_tracking: {
    state: 'partial',
    enforcedActions: ['view', 'dispatch', 'receive', 'mark_lost', 'close'],
    detail: 'Opening the module, and the dispatch/receive/mark-lost/close actions, are enforced. The others are saved but not yet used.',
  },

  // 'view' via src/app/orders/layout.tsx and the launcher; assignee
  // eligibility via 20260697000000. The three protected actions were added by
  // 20260901000000_finance_orders_permission_enforcement.sql:
  //   approve → convert_order_request_to_order, reject_order_request,
  //             request_order_request_clarification
  //   manage  → assert_order_amender, the choke point for amend_order and
  //             cancel_order
  //   delete  → admin_delete_order_request, plus the controlled cleanup path
  // create/edit stay on the existing ownership rules.
  // 'view_all' added by 20260903000000: it is what the two blanket SELECT
  // policies on orders and order_activity_log now require. Before that
  // migration those policies keyed on 'view', so module entry silently carried
  // company-wide sight — the defect this corrects.
  // 'approve_order' added by 20260908000000: it is the authority to review an
  // imported PI submission, checked by request_order_submission_changes() and
  // by the order_submissions / order-files visibility rules.
  //
  // 'approve' AND 'can_be_order_assignee' ARE GONE from this list because the
  // module no longer declares them (20261007000000 retires the Order Request
  // workflow and 20261008000000's sibling change removes the two options). They
  // were enforced by convert_order_request_to_order, reject_order_request,
  // request_order_request_clarification and is_eligible_order_assignee — every
  // one of which is now revoked from all client roles or unreachable. An entry
  // claiming they are enforced would be describing an authority nobody can
  // exercise.
  //
  // 'create' is enforced for the SUBMISSION path: create_order_submission() and
  // submit_order_submission() both require it. Edit still follows the
  // ownership rules on a PI Draft, so this entry cannot claim edit is enforced
  // module-wide.
  orders: {
    state: 'partial',
    enforcedActions: [
      'view', 'view_all', 'approve_order', 'manage', 'delete',
    ],
    detail: 'Opening the module, seeing all company orders, reviewing and approving PI submissions, managing and deleting are enforced. Edit still follows the ownership rules on a PI Draft.',
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
  // 'view_all' added by 20260903000000 as a new RLS policy on
  // finance_payment_requests and its activity log. Additive: Finance never had
  // a blanket SELECT policy, so ownership-scoped visibility is unchanged for
  // anyone without it.
  // 'view' added: src/app/finance/layout.tsx now resolves it instead of reading
  // app_modules.visibility_type. Note the split this creates and keep it
  // straight — `view` is MODULE ENTRY, and which payment records a person then
  // sees is still decided by the ownership policies plus 'view_all'.
  finance: {
    state: 'partial',
    enforcedActions: ['view', 'approve', 'manage', 'delete', 'view_all'],
    detail: 'Opening the module, approve, correct/reverse, delete and seeing all company payments are enforced. Which records you see, and create and edit, still follow record ownership.',
  },

  // The quotation actions are enforced in the app — the navigation, the
  // /tasks/quotation-requests routes and the quotation fields on task detail.
  // They are deliberately NOT enforced by RLS: a quotation request is assigned
  // work, and hiding the row would take an assignee's own task away from them.
  // See the limitation recorded in docs/Module Docs/ACCESS_CONTROL_V1.md.
  // view/create/edit/delete/export/manage remain unchecked for this module.
  // 'view' added: /dashboard and /tasks are behind ModuleGuard, and the
  // launcher card resolves the same grant. Module ENTRY is enforced; what a
  // person can do once inside still follows the existing task rules.
  task_management: {
    state: 'partial',
    enforcedActions: ['view', 'view_quotations', 'manage_quotations'],
    detail: 'Opening the module and the two quotation permissions are enforced. The other Task Management actions are saved but not yet used.',
  },

  // The three modules below were 'prepared' — "saved, nothing consults it yet" —
  // because nothing did. Each now has exactly ONE enforced action, module entry,
  // via its ModuleGuard layout and the matching launcher card. Everything inside
  // them is still governed by the pre-existing role checks, so 'partial' with a
  // single enforced action is the honest label, not 'enforced'.

  // Entry: src/app/showroom-admin/layout.tsx. The customer-facing /showroom tree
  // is public by design and is not part of this module's gate.
  showroom_qr: {
    state: 'partial',
    enforcedActions: ['view'],
    detail: 'Opening the module is enforced. Create, edit and manage are saved but not yet used.',
  },

  // Entry: src/app/admin/members/layout.tsx, in front of the page's own
  // admin-role bounce, which is unchanged.
  employee_records: {
    state: 'partial',
    enforcedActions: ['view'],
    detail: 'Opening the module is enforced. Everything inside is still admin-only by role.',
  },

  // Entry: src/app/performance/layout.tsx, covering /performance and
  // /performance/team. The team route stays authorized server-side as well.
  // The three that decide access are all enforced, in the screen AND in the API:
  //
  //   view       Personal Performance. src/app/performance/layout.tsx via
  //              ModuleGuard, and — the half that makes the claim true —
  //              GET/POST /api/performance, POST /api/daily-log (submitting an
  //              EOD) and the self branch of GET /api/performance-metrics,
  //              /api/daily-log and /api/performance-audit, all through
  //              canReadPerformanceOf in src/lib/permissions/performance.ts.
  //   view_team  src/app/performance/team/layout.tsx, plus
  //              GET /api/performance-metrics/team and GET /api/eod-logs/team.
  //   view_all   the scope filter applied to the employee list inside those two
  //              team routes, before any metric is computed, and to the target
  //              of every per-employee read. No query parameter widens it.
  //
  // create/edit/export/manage remain saved and unused — Performance has no
  // record anyone creates, edits or exports, and `manage` gates nothing. They
  // are left registered rather than removed because existing grants reference
  // them; this entry is `partial` for that reason and not because any access
  // decision is unenforced.
  performance: {
    state: 'partial',
    enforcedActions: ['view', 'view_team', 'view_all'],
    detail: 'Personal Performance, Team Performance and View All Employees are all enforced — in the screen and in the API. Create, Edit, Export and Manage are saved but decide nothing.',
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
