import type { SupabaseClient } from '@supabase/supabase-js'
import type { EffectivePermission } from './types'
import { getEffectivePermissions } from './resolver'

// Performance capability derivation.
//
// ROLE AND MODULE CAPABILITY ARE SEPARATE CONCEPTS. That sentence is the whole
// point of this file, and it is the rule the module previously broke.
//
// A Manager is two things at once: an individual employee who submits an EOD and
// carries a score of their own, and a manager who monitors other employees. Until
// this file existed, `manager` decided both — and it decided them in opposite
// directions. src/app/modules/page.tsx sent every admin and manager to
// /performance/team, so the launcher offered a manager no route to their own
// report at all; and src/app/performance/page.tsx refused any non-admin caller
// holding a View As target, so the one link that DID go there from the team
// screen ("view full report", which sets View As first) bounced a manager to
// /dashboard and left a stale `adminViewAs` key behind to bounce them again.
// Personal Performance was therefore something a Manager lost by being promoted,
// which is not a decision anybody made — it was a side effect of deriving a
// module capability from a role.
//
// THE THREE CAPABILITIES, and the action each maps to:
//
//   view       PERSONAL PERFORMANCE. Open /performance, see today's score, the
//              current and last month, the daily history, and submit your own
//              EOD with your own self-rating. This is also module entry — the
//              action ModuleGuard and the launcher already read (see
//              moduleVisibility.ts), so nothing about who may open the module
//              changed when this file landed.
//
//   view_team  TEAM PERFORMANCE. Open /performance/team and read the management
//              dataset: other employees' metrics, rankings, attention briefing
//              and EOD register. Protected — no access level hands it out.
//
//   view_all   FULL TEAM VISIBILITY. See EVERY eligible employee rather than
//              only the caller's own department. Protected, and deliberately
//              separate from view_team for the same reason Orders and Finance
//              register their own `view_all` separately (20260903000000):
//              "may open the management screen" and "may see the whole company
//              in it" are two decisions.
//
// The shape mirrors src/lib/permissions/finance.ts, including the admin
// short-circuit and the `withEntry` rule that a stronger action left behind by a
// half-finished grant cannot produce a control on a module the person cannot
// open.
//
// WHAT THIS FILE DOES NOT DECIDE. Whether an employee is COUNTED by Performance
// is `users.performance_tracking_enabled`, and it is a different question with a
// different answer — see performanceEligibility.ts, which says so at length. A
// manager who holds `view` but is not tracked keeps their personal page and is
// told, on it, that their figures appear in no team comparison.

export type PerformanceCapabilities = {
  /**
   * May open the Performance module and see their OWN report: today's score,
   * the current and last month, and their daily history.
   *
   * This is module entry. A caller without it must not reach /performance, and
   * must not reach the personal endpoints behind it either — hidden navigation
   * is not authorization.
   */
  canAccessPersonalPerformance: boolean
  /**
   * May submit their own EOD log and self-rating.
   *
   * Backed by the same `view` action as canAccessPersonalPerformance rather than
   * by an action of its own: the EOD form is part of the personal report, and a
   * separate key would put an administrator in front of a control that has no
   * screen to appear on. It is named separately because the two gate different
   * things and may well be split later, exactly as Assets split `assign` out of
   * `manage` in 20260725000000.
   */
  canSubmitOwnEod: boolean
  /**
   * May open Team Performance and read other employees' figures. Says nothing
   * about WHICH employees — that is canViewAllEmployeePerformance and the scope
   * rule below.
   */
  canAccessTeamPerformance: boolean
  /**
   * May see every eligible employee in Team Performance rather than only their
   * own department. Read-only by construction: it widens sight and confers no
   * authority over anybody.
   */
  canViewAllEmployeePerformance: boolean
}

export const NO_PERFORMANCE_CAPABILITIES: PerformanceCapabilities = {
  canAccessPersonalPerformance: false,
  canSubmitOwnEod: false,
  canAccessTeamPerformance: false,
  canViewAllEmployeePerformance: false,
}

const ALL_PERFORMANCE_CAPABILITIES: PerformanceCapabilities = {
  canAccessPersonalPerformance: true,
  canSubmitOwnEod: true,
  canAccessTeamPerformance: true,
  canViewAllEmployeePerformance: true,
}

export function derivePerformanceCapabilities(
  role: string | null | undefined,
  permissions: readonly EffectivePermission[],
): PerformanceCapabilities {
  // The project's established admin bypass, and the same one
  // canAccessManagementModule applies — so the launcher, the route guards and
  // this file agree about an administrator. Admins saw every employee before
  // this file existed and see every employee after it.
  if (role === 'admin') return { ...ALL_PERFORMANCE_CAPABILITIES }

  // A missing role means the profile read failed, not that the caller is an
  // ordinary employee. Fail closed, exactly as canAccessManagementModule does.
  if (!role) return { ...NO_PERFORMANCE_CAPABILITIES }

  const allowed = (actionKey: string) =>
    permissions.some(p => p.actionKey === actionKey && p.allowed)

  const canAccessPersonalPerformance = allowed('view')
  const withEntry = (actionKey: string) => canAccessPersonalPerformance && allowed(actionKey)

  const canAccessTeamPerformance = withEntry('view_team')

  return {
    canAccessPersonalPerformance,
    canSubmitOwnEod: canAccessPersonalPerformance,
    canAccessTeamPerformance,
    // Gated on team access as well as on its own action. Company-wide sight of a
    // screen the caller cannot open is a grant with nowhere to land — the same
    // rule ACTION_DEPENDENCIES states for the administrator, enforced here for
    // the request.
    canViewAllEmployeePerformance: canAccessTeamPerformance && allowed('view_all'),
  }
}

// ─── Scope: which employees a Team Performance caller may read ────────────────

/** The identity fields a scope decision reads. Kept minimal so any caller fits. */
export type PerformanceSubject = { id: string; team?: string | null }

/** Case- and whitespace-insensitive, and empty reads as absent, not as a team. */
function normalizeTeam(team: string | null | undefined): string | null {
  const trimmed = (team ?? '').trim().toLowerCase()
  return trimmed === '' ? null : trimmed
}

/**
 * Is this employee inside the caller's Team Performance scope?
 *
 * Three answers, in order:
 *   no team access            nobody, not even themselves — the screen is shut.
 *   view_all                  every employee. This is what every manager and
 *                             admin gets today, and the migration that
 *                             registers the action grants it at ROLE level to
 *                             both, so nobody's sight narrowed when it landed.
 *   view_team without view_all  themselves, plus their own department.
 *
 * A caller with no department of their own (`team` null or blank) falls back to
 * themselves alone. That is deliberate: matching "no department" against other
 * rows with no department would hand an unassigned manager an arbitrary set of
 * colleagues, and a scope nobody chose is worse than a scope that is too small.
 */
export function isWithinTeamPerformanceScope(
  caller: PerformanceSubject,
  capabilities: PerformanceCapabilities,
  employee: PerformanceSubject,
): boolean {
  if (!capabilities.canAccessTeamPerformance) return false
  if (capabilities.canViewAllEmployeePerformance) return true
  if (caller.id === employee.id) return true

  const callerTeam = normalizeTeam(caller.team)
  if (callerTeam === null) return false
  return callerTeam === normalizeTeam(employee.team)
}

/**
 * May this caller read performance data for this target?
 *
 * The one rule every per-employee endpoint asks — /api/performance-metrics,
 * /api/daily-log and /api/performance-audit — so a URL typed by hand and a
 * `userId` query parameter are answered by the same function as the screen.
 *
 * Reading YOUR OWN figures needs personal access and nothing else: team access
 * is not a substitute for it, because Personal Performance is the capability the
 * administrator switched off.
 */
export function canReadPerformanceOf(
  caller: PerformanceSubject,
  capabilities: PerformanceCapabilities,
  target: PerformanceSubject,
): boolean {
  if (caller.id === target.id) return capabilities.canAccessPersonalPerformance
  return isWithinTeamPerformanceScope(caller, capabilities, target)
}

// ─── Server-side resolution ───────────────────────────────────────────────────

/** The signed-in caller, as every Performance route needs to know them. */
export type PerformanceCaller = {
  id: string
  role: string
  team: string | null
  full_name: string
  position: string | null
}

export type PerformanceAccess = {
  caller: PerformanceCaller
  capabilities: PerformanceCapabilities
}

/**
 * Resolve the caller and their Performance capabilities from a bearer token.
 *
 * Every Performance API route starts here, so authorization is derived from the
 * authenticated user on the server and never from anything the client sends
 * about itself — no role, no actor id, no permission value.
 *
 * Returns null for an unidentified caller, which every caller turns into a 401.
 *
 * FAILS CLOSED, INDEPENDENTLY, on each read:
 *   profile read fails    → null, so nobody is admitted.
 *   permission RPC throws → empty permission list, so a non-admin is denied
 *                           every capability while an admin still passes on the
 *                           role short-circuit alone. Same degradation rule as
 *                           usePermissionContext.
 */
export async function resolvePerformanceAccess(
  // No generated Database type in this project — matches the untyped-client
  // pattern the Performance routes already use.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: SupabaseClient<any, any, any>,
  token: string,
): Promise<PerformanceAccess | null> {
  const { data: { user }, error } = await client.auth.getUser(token)
  if (error || !user) return null

  const { data } = await client
    .from('users')
    .select('id, role, full_name, team, position')
    .eq('id', user.id)
    .single()
  if (!data) return null

  const caller = data as PerformanceCaller

  let permissions: EffectivePermission[] = []
  try {
    permissions = await getEffectivePermissions(client, caller.id, 'performance')
  } catch {
    permissions = []
  }

  return { caller, capabilities: derivePerformanceCapabilities(caller.role, permissions) }
}
