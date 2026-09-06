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

/**
 * The action keys that MEAN "may open this module", most common first.
 *
 * A module registers exactly one of them, and `view` is that one everywhere
 * except Customer Review Outreach, which registers `use` and no `view` at all:
 * a holder there sees only their own outreach, so a separate read-only grant
 * would name an empty screen (see modules.ts and moduleVisibility.ts).
 *
 * This is an ORDERED PREFERENCE, not a set. If a module ever registered both,
 * `view` would decide — which is the conservative answer, because `view` is
 * what every route guard and the launcher already read.
 */
export const MODULE_ENTRY_ACTIONS = ['view', 'use'] as const

/**
 * The entry action for a module, given the actions it registers, or null when
 * it registers none of them.
 *
 * Null is a real answer and callers must handle it: a module with no entry
 * action cannot be switched on or off as a whole, and pretending otherwise
 * would put an administrator in front of a control that decides nothing.
 */
export function entryActionForModule(moduleActionKeys: readonly string[]): string | null {
  return MODULE_ENTRY_ACTIONS.find(action => moduleActionKeys.includes(action)) ?? null
}

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
 *   view_quotations        quotation requests and their customer contact
 *   manage_quotations      details. Commercially sensitive, so ordinary Task
 *                          Management access must not reach them.
 *   view_all               company-wide sight — every order, or every payment
 *                          record. Registered against Orders and Finance
 *                          separately by 20260903000000, so the two are granted
 *                          independently and neither implies the other. It was
 *                          `orders.view` that carried this until that migration,
 *                          which is the defect it corrects.
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
  'view_quotations',
  'manage_quotations',
  'view_all',
  // Reviewing and approving an imported PI submission. Protected because
  // approval is what eventually brings an Order into existence and burns an
  // order number; nobody should acquire it by picking "Manager" from a
  // dropdown. Registered by 20260908000000.
  'approve_order',
  // Deciding whether BOE will start an order on LESS than its standard 40%
  // advance — zero included. Protected, and deliberately separate from
  // approve_order: reviewing a PI and settling its commercial terms are two
  // decisions, and the business has chosen to keep them assignable to different
  // people. A preset that handed this out would be handing out money at risk.
  // Registered by 20260913000000.
  'approve_advance_exception',
  // Deciding which PI or Order a verified payment belongs to, and reversing an
  // allocation that has already been recorded. Protected for the reason every
  // financial authority here is: allocation is what makes money count toward a
  // piece of business, and reversal rewrites a fact that has already been
  // reported. Neither is something an administrator should acquire by picking
  // "Manager" from a dropdown, and they are deliberately separate from each
  // other and from finance.approve. Registered by 20260918000000.
  'allocate',
  'allocate_correct',
  // Saying that a customer really did publish a review, and closing the request
  // on the strength of it. Protected because it is the module's only claim
  // about the outside world that anybody else will rely on, and because the
  // separation from `use` is the whole safeguard: the employee who ran the
  // outreach must not be able to sign off their own outreach by default.
  // Registered by 20261017000000.
  'verify',
  // Reading, adding and editing the ACCESS REGISTER — every employee's login
  // and credential records. Protected for the plainest reason on this list:
  // access_records still stores secret_value in plain text (20260640), and the
  // table was admin-only for exactly that reason until it was delegated. It is
  // an authority an administrator must hand to a named person on purpose, one
  // person at a time, and never something acquired by picking "Manager" from a
  // dropdown. Registered by 20261028000000.
  'manage_access_records',
  // Opening Team Performance: every employee's score, ranking, EOD discipline
  // and attention briefing. Protected because it is sight of other people's
  // measured work — the authority an administrator must hand over on purpose
  // rather than acquire by picking "Manager" from a dropdown — and because the
  // whole point of registering it (20261109000000) is that Personal Performance
  // and Team Performance stop being one decision made by `users.role`.
  // `view_all` is already on this list and is what widens this one to the whole
  // company rather than the caller's own department.
  'view_team',
])

export function isProtectedAction(actionKey: string): boolean {
  return PROTECTED_ACTIONS.has(actionKey)
}

/**
 * Actions that are meaningless — or unsafe — without another action alongside
 * them, as `child → parent`.
 *
 * These are not a second permission model. They are the same "a grant must have
 * somewhere to act" rule that needsViewNormalization already applies to `view`,
 * extended to the pairs where the parent is itself narrower than the module.
 * Managing quotations without being able to see one is not a coherent state,
 * and company-wide sight of a module nobody can open is a grant with nowhere to
 * land.
 *
 * Chains resolve transitively: manage_quotations → view_quotations → view.
 */
export const ACTION_DEPENDENCIES: Readonly<Record<string, string>> = {
  manage_quotations: 'view_quotations',
  view_quotations:   'view',
  // Team Performance is inside the Performance module, so it cannot be held by
  // somebody who may not open it.
  view_team:         'view',
  // `view_all` widens a management screen the holder must already be able to
  // open. In Performance that screen is Team Performance, so the chain is
  // view_all → view_team → view; in Orders and Finance, which register no
  // `view_team`, withRequiredDependencies skips the missing link and the chain
  // resolves to `view` exactly as it did before — an action a module does not
  // declare is never invented.
  view_all:          'view_team',
  // A reviewer who cannot open Order Management cannot review anything, and
  // the RLS on order_submissions is gated on module entry as well — so the
  // grant would be one that could never land.
  approve_order:     'view',
  // Same reason, and NOT a dependency on approve_order: the two authorities are
  // independent in both directions by design.
  approve_advance_exception: 'view',
  // Customer Review Outreach expresses module entry as `use`, not `view` (it
  // registers no `view` at all — see modules.ts). A verifier who cannot open
  // the module cannot verify anything, so ticking Verify in Custom brings Use
  // with it. The chain stops there: `use` depends on nothing.
  verify: 'use',
  // The Access Register lives inside Assets & Access, and the RESTRICTIVE
  // `access_records_module_entry_gate` (20260905000000) requires effective
  // assets_access:view before ANY policy on that table is reached. Without this
  // dependency an administrator could tick Manage Access Records alone and
  // store a grant that the database would never honour — a permission with
  // nowhere to act, which is the exact failure needsViewNormalization exists
  // to prevent.
  manage_access_records: 'view',
}

/** Every action `actionKey` depends on, nearest first. Cycle-safe. */
export function actionDependencyChain(actionKey: string): string[] {
  const chain: string[] = []
  const seen = new Set<string>([actionKey])
  let current = ACTION_DEPENDENCIES[actionKey]
  while (current && !seen.has(current)) {
    chain.push(current)
    seen.add(current)
    current = ACTION_DEPENDENCIES[current]
  }
  return chain
}

/**
 * The actions that must be switched ON alongside the ones being granted.
 *
 * Applied to a Custom save so that ticking Manage Quotations cannot store an
 * authority the person could never exercise. Only ever adds, and only ever adds
 * actions the module actually registers.
 */
export function withRequiredDependencies(
  allowedActions: readonly string[],
  moduleActionKeys: readonly string[],
): string[] {
  const registered = new Set(moduleActionKeys)
  const out = new Set(allowedActions)
  for (const action of allowedActions) {
    for (const dependency of actionDependencyChain(action)) {
      if (registered.has(dependency)) out.add(dependency)
    }
  }
  return moduleActionKeys.filter(action => out.has(action))
}

/**
 * The actions that must come OFF when `actionKey` is switched off — everything
 * that depends on it, transitively.
 *
 * This is the half that matters for safety. Removing View Quotations has to
 * take Manage Quotations with it, or an administrator would believe they had
 * withdrawn quotation access while the stronger grant survived — the same
 * failure mode applyPresetToActions was corrected for.
 */
export function dependentActionsToRemove(
  actionKey: string,
  moduleActionKeys: readonly string[],
): string[] {
  const removed = new Set([actionKey])
  let changed = true
  while (changed) {
    changed = false
    for (const key of moduleActionKeys) {
      if (removed.has(key)) continue
      if (actionDependencyChain(key).some(dependency => removed.has(dependency))) {
        removed.add(key)
        changed = true
      }
    }
  }
  removed.delete(actionKey)
  return moduleActionKeys.filter(key => removed.has(key))
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
  // `approve` is still here, and still means whatever a module that declares it
  // means by it — Finance's payment verification, Assets' change requests, Task
  // Management's review. ORDERS NO LONGER DECLARES IT: it meant "convert an
  // Order Request" and that workflow is retired, so standardActionsForLevel
  // intersects it away for Orders and grants nothing there. Removing it here
  // would take payment verification away from every Finance manager.
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
 * The allow/deny map after switching MODULE ACCESS ON — entry, and nothing else.
 *
 * SWITCHING A MODULE ON IS NOT THE SAME DECISION AS PICKING A LEVEL, and this
 * function exists to keep the two apart.
 *
 * A preset is a complete statement: "this person is a Viewer" means view and
 * nothing else, which is why presetAllowedActions returns false for every other
 * action and why moving someone down to Viewer legitimately revokes what they
 * held. Ticking the Module access checkbox says something much smaller: "let
 * them in". It carries no opinion about what they may do once inside, so it
 * must not answer that question — least of all by answering "nothing".
 *
 * THE BUG THIS FIXES. The checkbox used to apply the Viewer preset, so enabling
 * a module wrote an explicit deny over every child action the employee held.
 * That erased Aditya's Sample Tracking dispatch, receive and mark_lost the
 * moment somebody switched his module access on, with no warning — the
 * destructive-action confirmation only ever ran on the OFF path. The ON path had
 * been unreachable for anyone holding a child action, because a module counted
 * as "on" whenever ANY action was allowed; once module entry correctly became
 * `view` alone, that same employee rendered as OFF and the path went live.
 *
 * Every existing value is copied through untouched, so the result naturally
 * reports as `custom` when child actions survive and as `viewer` when none do —
 * detectAccessLevel derives that, nothing here needs to assert it.
 *
 * Pure: `currentlyAllowed` is read, never written to.
 */
export function enableModuleEntry(
  moduleActionKeys: readonly string[],
  currentlyAllowed: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  const map: Record<string, boolean> = {}
  for (const action of moduleActionKeys) map[action] = currentlyAllowed[action] === true
  // A module that registers no entry action at all cannot express entry; leave
  // it exactly as it was rather than inventing a key the module does not
  // register.
  const entry = entryActionForModule(moduleActionKeys)
  if (entry) map[entry] = true
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
