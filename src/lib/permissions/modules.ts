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
    { actionKey: 'manage', displayName: 'Manage' },
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
  ],
})

// Order Requests (/orders/requests) is not a separate module — it lives
// under the same /orders route tree and inherits this module's 'view'
// permission via the shared src/app/orders/layout.tsx guard.
registerModule({
  moduleKey: 'orders',
  displayName: 'Order Management',
  description: 'Track confirmed orders from request through production and dispatch.',
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
