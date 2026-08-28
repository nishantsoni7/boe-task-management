import { registerModule } from './registry'

// Catalog of every module currently shipped in the app, mirroring the seed
// data in supabase/migrations/20260660_create_permission_engine.sql exactly
// (module_key, display_name, description, and supported actions).
//
// This file is a temporary stand-in for "modules register themselves."
// None of these features have an owning module file yet — they're spread
// across many route/page files — so there's nowhere else to put this today.
// When a module's own code is touched, move its registerModule() call out
// of here and into that module's source, and delete the entry below.
//
// Importing this file (for its side effects) is what populates the
// in-process registry that scripts/sync-permissions.ts reads from.

registerModule({
  moduleKey: 'task_management',
  displayName: 'Task Management',
  description: 'Create, assign, and track tasks across the team.',
  actions: [
    { actionKey: 'view', displayName: 'View' },
    { actionKey: 'create', displayName: 'Create' },
    { actionKey: 'edit', displayName: 'Edit' },
    { actionKey: 'delete', displayName: 'Delete' },
    { actionKey: 'export', displayName: 'Export' },
    { actionKey: 'manage', displayName: 'Manage' },
    // Quotation requests carry customer contact details and, where the
    // workflow grows them, quoted commercial terms. Ordinary Task Management
    // access must not reach them, so both are PROTECTED (see levels.ts) and
    // Custom-only. Registered by 20260903000000.
    { actionKey: 'view_quotations',   displayName: 'View Quotations & Prices' },
    { actionKey: 'manage_quotations', displayName: 'Submit Quotation Requests' },
  ],
})

registerModule({
  moduleKey: 'sample_tracking',
  displayName: 'Sample Tracking',
  description: 'Request catalogs, track dispatch and returns.',
  actions: [
    { actionKey: 'view', displayName: 'View' },
    { actionKey: 'create', displayName: 'Create' },
    { actionKey: 'edit', displayName: 'Edit' },
    { actionKey: 'delete', displayName: 'Delete' },
    { actionKey: 'approve', displayName: 'Approve' },
    { actionKey: 'export', displayName: 'Export' },
    { actionKey: 'manage', displayName: 'Manage' },
    // Custom actions added in Phase 3B to let this module's catalog fully
    // express the legacy employee_permissions keys (samples_dispatch,
    // samples_receive, samples_lost, samples_close). As of Phase 3F
    // (20260665_cutover_sample_tracking_rls_to_resolver.sql), these are the
    // live enforcement actions — sample_dispatches RLS and the Sample
    // Tracking app code call resolve_permission() against these keys.
    // employee_permissions/has_permission() remain in the schema, unused,
    // for rollback only.
    { actionKey: 'dispatch', displayName: 'Dispatch' },
    { actionKey: 'receive', displayName: 'Receive' },
    { actionKey: 'mark_lost', displayName: 'Mark Lost' },
    { actionKey: 'close', displayName: 'Close' },
  ],
})

registerModule({
  moduleKey: 'assets_access',
  displayName: 'Assets & Access',
  description: 'Assigned devices and access records.',
  actions: [
    { actionKey: 'view', displayName: 'View' },
    { actionKey: 'create', displayName: 'Create' },
    { actionKey: 'edit', displayName: 'Edit' },
    { actionKey: 'delete', displayName: 'Delete' },
    // 'manage' means the custody corrections reserved for administration —
    // returning an asset and marking one lost. Giving an available asset to
    // an employee was split out into its own action by 20260725000000,
    // because handing a laptop to a colleague and writing one off are not the
    // same decision. Custom action (is_system = false), like Sample
    // Tracking's dispatch/receive.
    { actionKey: 'manage', displayName: 'Manage' },
    { actionKey: 'assign', displayName: 'Assign Assets' },
  ],
})

registerModule({
  moduleKey: 'attendance',
  displayName: 'Attendance',
  description: 'Employee attendance records, uploads, and leave history.',
  actions: [
    { actionKey: 'view', displayName: 'View' },
    { actionKey: 'create', displayName: 'Create' },
    { actionKey: 'edit', displayName: 'Edit' },
    { actionKey: 'delete', displayName: 'Delete' },
    { actionKey: 'approve', displayName: 'Approve' },
    { actionKey: 'export', displayName: 'Export' },
    { actionKey: 'manage', displayName: 'Manage' },
  ],
})

registerModule({
  moduleKey: 'payroll',
  displayName: 'Payroll',
  description: 'Payroll runs, salary breakdowns, and payslips.',
  actions: [
    { actionKey: 'view', displayName: 'View' },
    { actionKey: 'edit', displayName: 'Edit' },
    { actionKey: 'approve', displayName: 'Approve' },
    { actionKey: 'export', displayName: 'Export' },
    { actionKey: 'manage', displayName: 'Manage' },
    { actionKey: 'admin', displayName: 'Admin' },
  ],
})

registerModule({
  moduleKey: 'showroom_qr',
  displayName: 'Showroom QR',
  description: 'QR-based showroom inquiries and quotations.',
  actions: [
    { actionKey: 'view', displayName: 'View' },
    { actionKey: 'create', displayName: 'Create' },
    { actionKey: 'edit', displayName: 'Edit' },
    { actionKey: 'manage', displayName: 'Manage' },
  ],
})

registerModule({
  moduleKey: 'employee_records',
  displayName: 'Employee Records',
  description: 'Employee profiles, roles, and team assignments.',
  actions: [
    { actionKey: 'view', displayName: 'View' },
    { actionKey: 'create', displayName: 'Create' },
    { actionKey: 'edit', displayName: 'Edit' },
    { actionKey: 'delete', displayName: 'Delete' },
    { actionKey: 'export', displayName: 'Export' },
    { actionKey: 'manage', displayName: 'Manage' },
    { actionKey: 'admin', displayName: 'Admin' },
  ],
})

registerModule({
  moduleKey: 'performance',
  displayName: 'Performance',
  description: 'Daily performance scores and trends.',
  actions: [
    { actionKey: 'view', displayName: 'View' },
    { actionKey: 'create', displayName: 'Create' },
    { actionKey: 'edit', displayName: 'Edit' },
    { actionKey: 'export', displayName: 'Export' },
    { actionKey: 'manage', displayName: 'Manage' },
  ],
})

registerModule({
  moduleKey: 'finance',
  displayName: 'Finance',
  description: 'Payment requests and financial records.',
  actions: [
    { actionKey: 'view', displayName: 'View' },
    { actionKey: 'create', displayName: 'Create' },
    { actionKey: 'edit', displayName: 'Edit' },
    { actionKey: 'delete', displayName: 'Delete' },
    { actionKey: 'approve', displayName: 'Approve' },
    { actionKey: 'export', displayName: 'Export' },
    { actionKey: 'manage', displayName: 'Manage' },
    // Company-wide sight of every payment record. Separate from 'view', which
    // is module entry plus the ownership-scoped rows the Finance RLS policies
    // already allow. SELECT authority only — it implies no mutation.
    // Registered by 20260903000000.
    { actionKey: 'view_all', displayName: 'View All Payments & Finance' },
    // Deciding which PI or Order a verified payment belongs to, and undoing that
    // decision. Two actions, not one: attaching money to a piece of business and
    // rewriting an attachment that has already been reported are different
    // authorities, and neither is finance.approve — which stays the verification
    // authority. Both are protected (see levels.ts). Registered by 20260918000000.
    { actionKey: 'allocate', displayName: 'Allocate Payments' },
    { actionKey: 'allocate_correct', displayName: 'Correct Payment Allocations' },
  ],
})

// Meetings owns its own source file (src/lib/permissions/meetings.ts derives
// its capabilities), but the registration stays here with the rest of the
// catalog so `npm run permissions:check` still sees one complete list.
// Mirrors the seed in supabase/migrations/20260814000000_create_meetings_module.sql.
registerModule({
  moduleKey: 'meetings',
  displayName: 'Meetings',
  description: 'Structured order-review meetings, SKU updates, and follow-ups.',
  actions: [
    { actionKey: 'view', displayName: 'View' },
    { actionKey: 'create', displayName: 'Create' },
    { actionKey: 'edit', displayName: 'Edit' },
    { actionKey: 'delete', displayName: 'Delete' },
    { actionKey: 'export', displayName: 'Export' },
    // 'manage' is what separates a manager from an attendee: it grants sight of
    // every meeting in the company, and the authority to complete or reopen
    // one. See src/lib/permissions/meetings.ts.
    { actionKey: 'manage', displayName: 'Manage' },
  ],
})

// Review Workflow Test (Internal) owns its own capability file
// (src/lib/permissions/customerReviewOutreach.ts), but the registration stays
// here with the rest of the catalog so `npm run permissions:check` still sees
// one complete list. Mirrors the seed in
// supabase/migrations/20261017000000_customer_review_outreach.sql.
//
// THE KEY AND BOTH ACTION KEYS ARE DELIBERATELY UNCHANGED. This module's
// purpose changed — it is now an internal rehearsal of a workflow, with no
// customer contact of any kind — but `customer_review_requests`, `use` and
// `verify` are the identifiers every existing Control Center grant is written
// against, and renaming them would silently revoke all of them. The DISPLAY
// name is what a human reads and is what changed. The ACTION display names stay
// as well, because Control Center shows them against grants already made and a
// relabelled action reads as a different one.
//
// TWO ACTIONS, AND NO `view`. Unlike every other module here, entry is `use`:
// there is no read-only audience for a tester's own booked cards, so a third
// "can open it and do nothing" grant would name an empty screen. `verify` is
// the separate authority to say a test was actually checked and to hand one
// back — protected (see levels.ts), because nobody should acquire it by picking
// a level from a dropdown, and dependent on `use`, because a verifier who
// cannot open the module cannot verify anything.
registerModule({
  moduleKey: 'customer_review_requests',
  displayName: 'Review Workflow Test (Internal)',
  description: 'Internal test workflow: book a test card, open WhatsApp to a BOE team number, confirm, screenshot, verify. No customer contact.',
  actions: [
    { actionKey: 'use',    displayName: 'Use Customer Review Outreach' },
    { actionKey: 'verify', displayName: 'Verify & Close Review Requests' },
  ],
})

// PI Drafts (/orders/drafts) is not a separate module — it lives under the same
// /orders route tree and inherits this module's 'view' permission via the shared
// src/app/orders/layout.tsx guard.
//
// TWO ACTIONS WERE REMOVED WHEN THE ORDER REQUEST WORKFLOW WAS RETIRED, because
// each existed only to authorize a step in it and each is now an Access Control
// option that grants nothing:
//
//   approve                 meant "convert an Order Request into an Order", and
//                           was checked by convert_order_request_to_order,
//                           reject_order_request and
//                           request_order_request_clarification
//                           (20260901000000). All three are revoked from every
//                           client role by 20261007000000 §4, and the database
//                           refuses the writes they would attempt.
//   can_be_order_assignee   meant "may be NAMED as an Order Request assignee",
//                           read by is_eligible_order_assignee from the request
//                           forms. No request can be created or edited, so
//                           nothing reads it.
//
// GRANTS ALREADY MADE ARE NOT DELETED by removing the options — this registry
// decides what may be OFFERED, not what exists — and a grant nothing reads
// confers nothing. Offering them would be the defect: an administrator would be
// choosing an authority that cannot be exercised, and would reasonably believe
// they had given somebody something.
//
// approve_order is UNAFFECTED and is the live review authority. It was
// deliberately never `approve` for exactly this reason: reusing that action
// would have handed PI approval to everyone who could convert an Order Request,
// silently, and the retirement would now be taking it away again just as
// silently.
registerModule({
  moduleKey: 'orders',
  displayName: 'Order Management',
  description: 'PI Drafts, confirmed orders, production and dispatch.',
  actions: [
    { actionKey: 'view', displayName: 'View' },
    { actionKey: 'create', displayName: 'Create' },
    { actionKey: 'edit', displayName: 'Edit' },
    { actionKey: 'delete', displayName: 'Delete' },
    { actionKey: 'export', displayName: 'Export' },
    { actionKey: 'manage', displayName: 'Manage' },
    // Authority to review an imported PI submission — the workbook an employee
    // uploads with no official order number — and to approve it into a numbered
    // Order. Registered by 20260908000000. This is now the ONLY approval
    // authority in the module's pre-Order workflow.
    { actionKey: 'approve_order', displayName: 'Approve Order Submissions' },
    // Authority to decide an ADVANCE EXCEPTION on a submitted PI — whether BOE
    // will start the order on less than its standard 40% advance, zero
    // included. Registered by 20260913000000.
    //
    // DELIBERATELY NOT approve_order. That one means "review this PI": send it
    // back, reject it, and approve it. Whether to accept a lower
    // advance is a commercial decision about money at risk, and reusing
    // approve_order would have handed it, silently and retroactively, to
    // everybody who can already send a PI back. The two are independent in both
    // directions: holding this grants no PI review, no order visibility, no
    // Finance sight and no payment access.
    { actionKey: 'approve_advance_exception', displayName: 'Approve Advance Exceptions' },
    // Company-wide sight of every order. Until 20260903000000, plain 'view'
    // carried this through the blanket SELECT policies added by 20260685000000
    // and 20260686000000 — module entry and seeing the whole company were the
    // same grant. They are now separate decisions: 'view' opens the module and
    // leaves record visibility to the ownership policies, and this action is
    // what widens it. Confers no edit, approve, manage, delete, assignee
    // eligibility, or any Finance or quotation sight.
    { actionKey: 'view_all', displayName: 'View All Company Orders' },
  ],
})
