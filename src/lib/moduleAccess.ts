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
//   resolveModuleAccess(...) the whole decision for one module: the four modes
//                            plus `custom` member lists. This answers "may this
//                            person open this module's card", and nothing more.
//
//   resolveManagementAccess(...) whether this person may run the module's
//                            ADMINISTRATIVE surface. For Attendance and Payroll
//                            that is admins only, whatever visibility says.
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
 * SELF-SERVICE MODULES — salary and attendance are private employee data.
 *
 * This restriction is deliberate and approved. Read this before touching it.
 *
 * Attendance and Payroll are two experiences wearing one name, and they must
 * never be mixed:
 *
 *   MANAGEMENT   `/attendance` and `/payroll`. Every screen under them reads the
 *                whole company — everybody's punches, everybody's salary,
 *                everybody's deduction ledger. ADMINS ONLY, always. No
 *                visibility setting can open these to anyone else, because a
 *                launcher toggle must never be able to disclose the payroll of
 *                people the viewer does not manage.
 *
 *   SELF-SERVICE `/my-attendance` and `/my-payroll`. An employee's own record,
 *                and only ever their own. Served by APIs that derive the
 *                employee from the bearer token, so a cross-employee read is
 *                inexpressible rather than merely refused.
 *
 * The `app_modules` visibility row governs the SELF-SERVICE surface only: it
 * decides whether an employee sees an Attendance or Payroll card at all, and
 * `custom` names the individuals who do. It has no bearing on management access.
 *
 * An earlier version of this file treated `custom` as a grant of management
 * access — a named member could then read the whole company's salaries. That
 * interpretation was rejected by the product owner and must not come back. If
 * you are here to make `custom` "work properly" for Attendance or Payroll: it
 * already does, and what it grants is the employee's own record.
 *
 * Row-level access inside the modules is still enforced separately by RLS and by
 * the service-role routes — see
 * supabase/migrations/20260812000000_attendance_payroll_isolation.sql.
 */
export const SELF_SERVICE_MODULE_KEYS: ReadonlySet<string> = new Set([
  'attendance',
  'payroll',
])

export function isSelfServiceModule(moduleKey: string): boolean {
  return SELF_SERVICE_MODULE_KEYS.has(moduleKey)
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
 * Whether this person may open the module's card.
 *
 * For Attendance and Payroll that means their SELF-SERVICE view — see
 * SELF_SERVICE_MODULE_KEYS. Use resolveManagementAccess for the administrative
 * surface; this function must never be what stands between an employee and
 * another employee's salary.
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

  return canAccessModule(visibility, row?.allowed_department, profile, fallback)
}

/**
 * Whether this person may run the module's ADMINISTRATIVE surface — the screens
 * and APIs that read across employees.
 *
 * For Attendance and Payroll the answer is `admin`, and no visibility mode can
 * change it. `custom` names the employees who get their OWN record; it is not a
 * back door into everybody else's. Modules outside SELF_SERVICE_MODULE_KEYS have
 * no such split and fall through to the ordinary decision.
 *
 * `hidden` still closes a module for everyone, admins included, exactly as
 * before — a module switched off is off.
 */
export function resolveManagementAccess(
  moduleKey: string,
  row: ModuleAccessRow | null | undefined,
  profile: AccessProfile,
  fallback: boolean,
): boolean {
  if (!profile) return false

  const visibility = row?.visibility_type
  if (!visibility) return fallback
  if (visibility === 'hidden') return false

  if (isSelfServiceModule(moduleKey)) return profile.role === 'admin'

  return resolveModuleAccess(moduleKey, row, profile, fallback)
}
