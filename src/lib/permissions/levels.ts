import type { EffectivePermission } from './types'

// Administrator-facing access levels — the V1 Access Control vocabulary.
//
// These are a presentation layer over the granular action engine, not a new
// storage model. Nothing here is written to the database: a level is turned
// into a set of action keys, and those action keys are what
// employee_permission_overrides stores, exactly as they do today.
//
// This file supersedes the level logic that currently lives inline in
// src/app/admin/control-center/permissions/page.tsx (AccessLevel, LEVELS,
// presetAllowedActions, detectAccessLevel). That page still carries its own
// older copy — no_access/viewer/EDITOR/manager/ADMIN/custom — and is
// deliberately left alone for now: rewiring it changes what an administrator
// sees and can save, which belongs with the unified Access Control screen and
// not with this foundation. When that screen lands, delete the page-local copy
// and import from here.
//
// WHAT CHANGED FROM THE PAGE-LOCAL VERSION
//
//   'editor' was renamed 'contributor' — the same three actions.
//   'admin'  was REMOVED as a level. It granted every registered action,
//            including delete, assign, dispatch and the rest, from a single
//            click. Anything above Manager is now Custom, action by action.
//   'manager' gained 'export' and lost 'manage'. `manage` is what lets someone
//            act across the whole organisation in every module that enforces
//            it (see assetsAccess.ts, meetings.ts), so it is no longer
//            something a preset hands out.

export const ACCESS_LEVELS = ['no_access', 'viewer', 'contributor', 'manager', 'custom'] as const

export type AccessLevel = (typeof ACCESS_LEVELS)[number]

/** Every level except `custom`, which by definition has no fixed action set. */
export type PresetLevel = Exclude<AccessLevel, 'custom'>

export const PRESET_LEVELS: readonly PresetLevel[] = ['no_access', 'viewer', 'contributor', 'manager']

export const ACCESS_LEVEL_LABELS: Record<AccessLevel, { label: string; description: string }> = {
  no_access:   { label: 'No Access',   description: 'Cannot open or use this module.' },
  viewer:      { label: 'Viewer',      description: 'Can view only.' },
  contributor: { label: 'Contributor', description: 'Can view, create, and edit.' },
  manager:     { label: 'Manager',     description: 'Can view, create, edit, and — where the module has them — approve and export.' },
  custom:      { label: 'Custom',      description: 'Individually selected actions, including protected ones.' },
}

/**
 * PROTECTED ACTIONS — never granted by a preset, at any level.
 *
 * The rule this constant exists to state: a level is a convenience, and a
 * convenience must not be able to hand over an authority whose blast radius
 * the administrator did not consciously choose. Every key below is either
 * irreversible, organisation-wide, or an authority the business has already
 * decided to keep separable.
 *
 *   delete                 removes records
 *   admin                  the strongest action any module declares
 *   manage                 organisation-wide sight and control — in Assets it
 *                          is return/mark-lost/review, in Meetings it is every
 *                          meeting in the company plus complete/reopen
 *   assign                 split out of `manage` on purpose by migration
 *                          20260725000000, so that handing a colleague a
 *                          laptop and writing one off are two decisions. This
 *                          is the authority Aditya holds and it must stay
 *                          independent of edit, delete and manage.
 *   dispatch receive
 *   mark_lost close        Sample Tracking's lifecycle transitions
 *   can_be_order_assignee  eligibility to be named on an Order Request. Granted
 *                          only per person by design (20260697000000) — never
 *                          via a role or a preset.
 *
 * Payroll generation/adjustment/lock-unlock, attendance import and correction,
 * permanent deletion, password reset and employee access changes are NOT in
 * this set because no module declares an action key for them: they are admin-
 * only route checks in V1 and the engine never decides them. They are listed
 * in the V1 protected-actions documentation for the same reason — a preset
 * must never reach them — but the enforcement is the absence of an action key,
 * which is stronger than a deny-list entry.
 */
export const PROTECTED_ACTIONS: ReadonlySet<string> = new Set([
  'delete',
  'admin',
  'manage',
  'assign',
  'dispatch',
  'receive',
  'mark_lost',
  'close',
  'can_be_order_assignee',
])

export function isProtectedAction(actionKey: string): boolean {
  return PROTECTED_ACTIONS.has(actionKey)
}

/**
 * The STANDARD actions each level asks for, before a module is consulted.
 *
 * Cumulative going down the list. A module that does not register one of these
 * keys simply does not get it — see standardActionsForLevel, which is the only
 * function that should ever be used to turn a level into real action keys.
 */
export const STANDARD_LEVEL_ACTIONS: Record<PresetLevel, readonly string[]> = {
  no_access:   [],
  viewer:      ['view'],
  contributor: ['view', 'create', 'edit'],
  manager:     ['view', 'create', 'edit', 'approve', 'export'],
}

/**
 * The actions a level grants FOR THIS MODULE — the intersection of the level's
 * standard set with the actions the module actually registers, minus anything
 * protected.
 *
 * Two invariants, both load-bearing:
 *   - an action a module does not declare is never invented, so Payroll cannot
 *     acquire a `create` it has no meaning for;
 *   - a protected action never appears, even if a future edit adds one to
 *     STANDARD_LEVEL_ACTIONS by mistake. The filter is applied here rather
 *     than trusted upstream.
 */
export function standardActionsForLevel(
  level: PresetLevel,
  moduleActionKeys: readonly string[],
): string[] {
  const registered = new Set(moduleActionKeys)
  return STANDARD_LEVEL_ACTIONS[level].filter(
    action => registered.has(action) && !isProtectedAction(action),
  )
}

/**
 * The full allow/deny map a preset writes for one module: every registered
 * action, with the ones this level grants set to true.
 *
 * Protected actions are always false here. That is not the same as revoking
 * them — see applyPresetToActions for how an existing protected grant is
 * preserved when an administrator moves someone between levels.
 */
export function presetAllowedActions(
  level: PresetLevel,
  moduleActionKeys: readonly string[],
): Record<string, boolean> {
  const granted = new Set(standardActionsForLevel(level, moduleActionKeys))
  const map: Record<string, boolean> = {}
  for (const action of moduleActionKeys) map[action] = granted.has(action)
  return map
}

/**
 * Whether a set of allowed actions would leave someone able to act on a module
 * they cannot open.
 *
 * `view` is what the module-visibility rule reads (see moduleVisibility.ts).
 * Granting create or edit without it produces an employee who holds real
 * authority over a module that renders no card and whose route guard bounces
 * them — a permission with nowhere to act.
 */
export function needsViewNormalization(
  allowedActions: readonly string[],
  moduleActionKeys: readonly string[],
): boolean {
  return (
    allowedActions.length > 0 &&
    moduleActionKeys.includes('view') &&
    !allowedActions.includes('view')
  )
}

/**
 * Adds `view` to a set of actions about to be written, when the module has a
 * `view` action and anything at all is being granted.
 *
 * Applied to PRESET WRITES and to CUSTOM WRITES alike: an administrator
 * hand-picking `approve` in Custom has the same intent as one picking Manager,
 * and neither should produce an invisible module. It never removes anything.
 */
export function normalizeGrantedActions(
  allowedActions: readonly string[],
  moduleActionKeys: readonly string[],
): string[] {
  const out = moduleActionKeys.filter(action => allowedActions.includes(action))
  if (needsViewNormalization(out, moduleActionKeys)) out.unshift('view')
  return out
}

/**
 * The complete intended allow/deny map for one module when an administrator
 * picks a standard level. Every registered action appears, so the caller can
 * compute a full diff rather than a partial one.
 *
 * A STANDARD PRESET CLEARS PROTECTED ACTIONS. This is the correction to the
 * first version of this file, which carried a held protected action through a
 * level change on the reasoning that a level "has no opinion" about it. That
 * was unsafe in the direction that matters: an administrator moving somebody
 * DOWN to Viewer would have believed they had reduced that person to read-only
 * while `manage`, `delete` or `assign` quietly survived. A level the
 * administrator can read off the screen must be the whole truth about what it
 * grants, so `viewer` means view and nothing else.
 *
 * The consequence is deliberate and must be surfaced in the UI: switching
 * someone off Custom onto a standard level is a REVOCATION of their protected
 * actions. Aditya's `assign` survives only while his module stays on Custom —
 * which is exactly where detectAccessLevel reports it, because any set holding
 * a protected action is `custom` by definition and never matches a preset.
 *
 * This function is pure. It reads no stored state and writes none: it returns
 * the state a save WOULD produce. Nothing is persisted until a caller acts on
 * it, and no employee's permissions change merely by rendering a level.
 *
 * The booleans are intended state, not a write instruction. A caller deciding
 * between "revoke the override" and "store an explicit deny" makes that choice
 * itself — see the PUT handler in
 * src/app/api/control-center/permissions/employees/[id]/route.ts, which treats
 * null as revert-to-inherited and false as an explicit deny.
 */
export function applyPresetToActions(
  level: PresetLevel,
  moduleActionKeys: readonly string[],
): Record<string, boolean> {
  return presetAllowedActions(level, moduleActionKeys)
}

/**
 * The protected actions a move to `level` would take away from someone who
 * currently holds them — what a confirmation prompt needs to name.
 *
 * Pure: `currentlyAllowed` is read, never written to.
 */
export function protectedActionsClearedByPreset(
  level: PresetLevel,
  moduleActionKeys: readonly string[],
  currentlyAllowed: Readonly<Record<string, boolean>>,
): string[] {
  return moduleActionKeys.filter(
    action => isProtectedAction(action) && currentlyAllowed[action] === true,
  )
}

/**
 * Which level an employee's current effective actions correspond to.
 *
 * Matched in increasing order of privilege so an ambiguous set reports the more
 * conservative label. Anything that is not an exact match — most importantly
 * anything holding a protected action — is `custom`, which is the honest
 * answer: no level describes it.
 */
export function detectAccessLevel(
  moduleActionKeys: readonly string[],
  effectiveAllowed: Record<string, boolean>,
): AccessLevel {
  for (const level of PRESET_LEVELS) {
    const preset = presetAllowedActions(level, moduleActionKeys)
    if (moduleActionKeys.every(action => !!preset[action] === !!effectiveAllowed[action])) return level
  }
  return 'custom'
}

/** Convenience: the resolver's row shape reduced to the allow/deny map above. */
export function allowedMapFromEffective(
  permissions: readonly EffectivePermission[],
): Record<string, boolean> {
  const map: Record<string, boolean> = {}
  for (const permission of permissions) map[permission.actionKey] = permission.allowed
  return map
}
