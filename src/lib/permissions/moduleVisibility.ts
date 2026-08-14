import type { EffectivePermission } from './types'
import { isSelfServiceModule } from '@/lib/moduleAccess'

// One rule for whether a MANAGEMENT module is visible and enterable.
//
// This is the helper the unified Access Control workspace is built on: the
// launcher card, the navigation entry and the route guard must all read the
// same answer, so that hiding a card and blocking a URL can never disagree.
//
// It is now the LIVE rule. src/app/modules/page.tsx and every module route
// guard (src/components/layout/ModuleGuard.tsx) call it for each key in
// ENGINE_GATED_MODULE_KEYS below. Until this landed the launcher asked
// app_modules for eight modules and the permission engine for two, so an
// employee whose module access had been switched OFF in Access Control still
// saw the card and could still open the URL. That is the defect this closes.
//
// THE RULE
//
//   admin           may open any ACTIVE module. Matches the short-circuit every
//                   cut-over guard already has (orders/layout.tsx,
//                   meetings/layout.tsx, assetsAccess.ts).
//   everyone else   needs effective `view` on that module. Nothing else counts.
//
// Why `view` strictly, and not "any allowed action implies entry"
// --------------------------------------------------------------
// assetsAccess.ts and meetings.ts both treat create/edit/manage as implying
// entry, because they had to: a grant made before those modules cut over could
// legitimately lack `view`. That inference is the wrong default going forward —
// it means an administrator who ticks a single action in Custom silently opens
// a module, and it makes "is this module visible" depend on the union of every
// action rather than on one readable fact.
//
// V1 inverts the fix: entry requires `view`, and preset and custom WRITES are
// normalized to include `view` whenever anything is granted (see
// normalizeGrantedActions in ./levels.ts). The employee ends up in the same
// place; the difference is that the grant is explicit in the database instead
// of inferred at read time.
//
// Those two existing helpers are deliberately NOT changed here. They are live,
// enforced against RLS, and altering their entry rule would change production
// behaviour for Assets and Meetings — which this prompt is not doing.
//
// ATTENDANCE AND PAYROLL
// ----------------------
// This helper must never be what decides an employee's access to their own
// attendance or payslip. `/my-attendance` and `/my-payroll` are self-service:
// they are served by APIs that derive the employee from the bearer token, and
// their availability is not a management-module question. The management
// surfaces `/attendance` and `/payroll` read the whole company and stay
// admin-only in V1, which is what this helper returns for them — but the
// answer comes from the role check below, never from an engine grant, so a
// stray `payroll: view` row can never open them. See SELF_SERVICE_MODULE_KEYS
// and resolveManagementAccess in src/lib/moduleAccess.ts.

/**
 * The modules whose ENTRY is decided by the permission engine — effective
 * `view` — and not by `app_modules.visibility_type`.
 *
 * Orders and Meetings were already here in behaviour before this list existed;
 * they are the working controls. The other seven were gated by
 * `app_modules.visibility_type`, which Access Control does not write, so
 * unticking "Module access" for an employee changed a stored override that
 * nothing read. Every key below now resolves through canAccessManagementModule.
 *
 * Attendance and Payroll are deliberately ABSENT. Their management surfaces are
 * admin-only by product decision and their self-service surfaces are a separate
 * experience keyed off the bearer token — see SELF_SERVICE_MODULE_KEYS. Adding
 * either key here would be a behaviour change to a module this work does not
 * touch.
 *
 * `app_modules` is NOT dropped. Showroom QR's department rule and the
 * Attendance/Payroll self-service cards still read it, and `?tab=modules`
 * still resolves for rollback. What changed is that for these nine keys it is
 * no longer the EMPLOYEE AUTHORIZATION decision.
 */
export const ENGINE_GATED_MODULE_KEYS = [
  'task_management',
  'sample_tracking',
  'assets_access',
  'showroom_qr',
  'employee_records',
  'performance',
  'finance',
  'orders',
  'meetings',
] as const

export type EngineGatedModuleKey = (typeof ENGINE_GATED_MODULE_KEYS)[number]

export function isEngineGatedModule(moduleKey: string): boolean {
  return (ENGINE_GATED_MODULE_KEYS as readonly string[]).includes(moduleKey)
}

export type ModuleVisibilityInput = {
  /** users.role for the SIGNED-IN person. View As never lends permissions. */
  role: string | null | undefined
  moduleKey: string
  /** permission_modules.is_active — a deactivated module is off for everyone. */
  isModuleActive: boolean
  /** Effective permissions for THIS module, from the resolver. */
  permissions: readonly EffectivePermission[]
}

export function isAdminRole(role: string | null | undefined): boolean {
  return role === 'admin'
}

/**
 * Whether this person may see the card for, and enter, a management module.
 *
 * Returns false for Attendance and Payroll unless the caller is an admin,
 * whatever the engine says — see the note above.
 */
export function canAccessManagementModule({
  role,
  moduleKey,
  isModuleActive,
  permissions,
}: ModuleVisibilityInput): boolean {
  if (!isModuleActive) return false

  // A missing role means the profile read failed, not that the caller is an
  // ordinary employee. Fail closed, exactly as resolveModuleAccess does on a
  // null profile — an unidentified caller holding a stale permission row must
  // never be admitted.
  if (!role) return false

  if (isAdminRole(role)) return true

  // Management Attendance and Payroll are admin-only in V1. Reached only by a
  // non-admin, so this is always a denial; it is written as an explicit branch
  // rather than an omission so that adding a `view` row to either module later
  // cannot quietly open the company's salary ledger.
  if (isSelfServiceModule(moduleKey)) return false

  return permissions.some(permission => permission.actionKey === 'view' && permission.allowed)
}

/**
 * The subset of module keys a person may see, given every module's effective
 * permissions. The shape getEffectivePermissionsForUser already returns.
 */
export function visibleManagementModules(
  role: string | null | undefined,
  modules: readonly { moduleKey: string; isActive: boolean }[],
  permissionsByModule: ReadonlyMap<string, readonly EffectivePermission[]>,
): string[] {
  return modules
    .filter(mod =>
      canAccessManagementModule({
        role,
        moduleKey: mod.moduleKey,
        isModuleActive: mod.isActive,
        permissions: permissionsByModule.get(mod.moduleKey) ?? [],
      }),
    )
    .map(mod => mod.moduleKey)
}
