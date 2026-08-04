// The columns of public.users a browser-authenticated client is allowed to read.
//
// Why this exists as a constant rather than a convention
// ------------------------------------------------------
// `public.users` holds two Admin-only HR facts in the same row as everybody's
// display name: `monthly_salary` and `payroll_notes`. Row-level security cannot
// help — every employee legitimately needs to read every other employee's ROW
// (to render an assignee list, a task's owner, an order's salesperson), and RLS
// filters rows, not columns. The control is therefore a PostgreSQL column
// privilege: `authenticated` has SELECT on the columns below and on nothing
// else, enforced by migration 20260813000000.
//
// The consequence that matters when writing a query: `select('*')` against
// public.users is now a **permission error**, not a wide read. Postgres expands
// `*` to every column, including the two the role cannot see, and refuses the
// whole statement. So any browser query that wants a profile must name its
// columns — this constant is the shared answer, and
// src/lib/users/noStarSelect.test.ts fails the build if a browser file
// reintroduces `select('*')`.
//
// Admin screens that genuinely need salary do not read it here. They call an
// admin-gated service-role route (`/api/admin/employee-profile`,
// `/api/employee-list`), which checks the caller is an admin and returns an
// explicit field list.

/**
 * Every non-private column of public.users, in table order. Use this for a
 * self-profile fetch (`.eq('id', session.user.id).single()`) — the shape it
 * returns is what `UserProfile` describes, minus the two Admin-only fields.
 */
export const USER_PROFILE_COLUMNS = [
  'id',
  'full_name',
  'email',
  'phone',
  'role',
  'team',
  'position',
  'is_active',
  'created_at',
  'employee_code',
  'joining_date',
  'office_timing',
  'fingerprint_employee_code',
  'payroll_active',
  'employment_type',
  'is_deleted',
  'deleted_at',
  'deleted_by',
  'deletion_scheduled_at',
].join(', ')

/**
 * The columns `authenticated` must never hold a SELECT grant on. Kept here so
 * the repository check and the migration can be read against one list.
 */
export const USER_PRIVATE_COLUMNS = [
  'monthly_salary',
  'payroll_notes',
  // Management's reason for excluding someone from performance tracking. An
  // Admin-only HR note in the same sense as the two above, and read only by the
  // admin-gated Team Performance route.
  'performance_tracking_note',
] as const
