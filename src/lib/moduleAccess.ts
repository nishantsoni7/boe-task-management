// Shared visibility check for app_modules-gated routes.
// Mirrors the Control Center visibility model:
//   live / admin_only / department_only / custom / hidden.
//
// There are two entry points here and the difference matters:
//
//   canAccessModule(...)     the original four-mode check. Still used by the
//                            Showroom screens and the Finance guard, which pass
//                            loose columns rather than a row.
//
//   resolveModuleAccess(...) the whole decision for one module: the four modes,
//                            plus `custom` member lists, plus the explicit-grant
//                            rule below. This is what the launcher, the
//                            Attendance/Payroll route guards and the server-side
//                            API auth all call, so a card cannot appear to
//                            someone the route will bounce.
//
// Every mode fails closed on anything it does not understand.

export type ModuleVisibilityType =
  | 'live'
  | 'admin_only'
  | 'department_only'
  | 'hidden'
  | 'custom'

type AccessProfile = { id?: string | null; role: string; team?: string | null } | null

/** The app_modules columns an access decision reads. */
export type ModuleAccessRow = {
  visibility_type?: string | null
  allowed_department?: string[] | null
  allowed_user_ids?: string[] | null
}

/**
 * MANAGEMENT MODULES — access must be granted explicitly, never broadly.
 *
 * This restriction is deliberate and approved. It is not an accident of
 * refactoring, and a future change that "simplifies" it away would re-open the
 * hole it exists to close. Read this before touching it.
 *
 * `/attendance` and `/payroll` are MANAGEMENT surfaces. Every screen under them
 * reads the whole company — everybody's punches, everybody's salary, everybody's
 * deduction ledger. There is no self-scoped view inside either one. So
 * "visible to everyone" and "visible to a department" are not statements anybody
 * should be able to make about them: `live` and `department_only` would turn a
 * launcher toggle into a company-wide payroll disclosure. For these two modules
 * those modes therefore NARROW what is shown and never grant — access is either
 * admin, or named person by person through `custom` in
 * Control Center → Module Visibility.
 *
 * EMPLOYEE SELF-SERVICE IS A DIFFERENT SURFACE AND IS NOT AFFECTED.
 * An employee reaches their own payslip at `/my-payroll`, served by
 * `/api/payroll/my-result`, which is open to any authenticated caller and hard-
 * scoped to `caller.id`. It is not gated by the `payroll` app_modules row at all,
 * and nothing here can close it. The same split holds on the attendance side:
 * `/api/attendance/records`, `/api/attendance/employee-records` and
 * `/api/attendance/employee-monthly-detail` all pin a non-privileged caller to
 * their own id. So this constant restricts MANAGEMENT access only; it has never
 * governed, and must never govern, an employee's access to their own record.
 *
 * Granting `custom` on these modules is granting management access, and is meant
 * to be: a named member can then read what the module manages. It does NOT grant
 * mutations — import, payroll generation, period creation, locking, unlocking,
 * adjustments and corrections all keep their own role checks in their own
 * routes.
 *
 * This is the ONE place the rule lives. The launcher, the route guards and the
 * API routes all reach it through resolveModuleAccess, so there is no second
 * opinion to drift out of sync. Row-level access inside the modules is still
 * enforced separately by RLS and by the service-role routes — see
 * supabase/migrations/20260812000000_attendance_payroll_isolation.sql.
 */
export const EXPLICIT_GRANT_MODULE_KEYS: ReadonlySet<string> = new Set([
  'attendance',
  'payroll',
])

export function isExplicitGrantModule(moduleKey: string): boolean {
  return EXPLICIT_GRANT_MODULE_KEYS.has(moduleKey)
}

export function canAccessModule(
  visibilityType: ModuleVisibilityType | string | undefined | null,
  allowedDepartments: string[] | null | undefined,
  profile: AccessProfile,
  fallback: boolean,
): boolean {
  if (!visibilityType || !profile) return fallback
  const isAdmin = profile.role === 'admin'
  switch (visibilityType) {
    case 'hidden':          return false
    case 'admin_only':      return isAdmin
    case 'department_only': {
      const team = profile.team?.toLowerCase()
      return isAdmin || (!!team && !!allowedDepartments?.some(d => d.toLowerCase() === team))
    }
    // A caller that does not pass the member list cannot evaluate `custom`, so
    // it admits admins only. Callers that need the real answer use
    // resolveModuleAccess.
    case 'custom':          return isAdmin
    case 'live':            return true
    // Unknown mode — a value this build does not know about. Deny rather than
    // fall through to `live`, so a newer mode written by a newer deploy cannot
    // read as "open to everyone" here.
    default:                return isAdmin
  }
}

/**
 * The complete access decision for one module.
 *
 * `fallback` applies only when there is no app_modules row at all (a module the
 * registry has not been seeded with yet); a row that exists always decides.
 */
export function resolveModuleAccess(
  moduleKey: string,
  row: ModuleAccessRow | null | undefined,
  profile: AccessProfile,
  fallback: boolean,
): boolean {
  if (!profile) return false
  const isAdmin = profile.role === 'admin'

  const visibility = row?.visibility_type
  if (!visibility) return fallback

  // Hidden means hidden, for everyone, in every module. It is the one mode that
  // outranks the explicit-grant rule below.
  if (visibility === 'hidden') return false

  if (visibility === 'custom') {
    if (isAdmin) return true
    const id = profile.id
    if (!id) return false
    return (row?.allowed_user_ids ?? []).includes(id)
  }

  // See EXPLICIT_GRANT_MODULE_KEYS: broad modes cannot grant these.
  if (isExplicitGrantModule(moduleKey)) return isAdmin

  return canAccessModule(visibility, row?.allowed_department, profile, fallback)
}
