import type { PermissionLevel } from './types'
import { entryActionForModule, detectAccessLevel, type AccessLevel } from './levels'

// ── How Access Control turns an intention into override rows ─────────────────
//
// Two screens edit employee permissions — By Employee (one person, every
// module) and By Module (one module, every person) — and both must store
// exactly the same thing for the same intention. This file is that one rule.
//
// Nothing here is a permission decision. The resolver decides
// (resolve_effective_permissions_for_user, precedence Employee Override >
// Department > Role > System Default); these helpers only describe which
// employee_permission_overrides rows to write so that the resolver's answer
// becomes what the administrator asked for, and they write nothing where an
// inherited value already matches.

export type PermissionSource = PermissionLevel

/** One action of one module as the resolver reported it for one employee. */
export type ResolvedAction = {
  actionKey: string
  allowed: boolean
  source: PermissionSource
}

/** A pending choice per action: 'inherit' means "no employee override". */
export type OverrideChoice = 'inherit' | 'allow' | 'deny'

/** One entry of the PUT /api/control-center/permissions/employees/[id] payload. */
export type OverrideChange = { moduleKey: string; actionKey: string; allowed: boolean | null }

/** `view` for every module that registers it; `use` where a module has no `view`. */
export const MODULE_ENTRY_FALLBACK = 'view'

export function moduleEntryAction(actionKeys: readonly string[]): string {
  return entryActionForModule(actionKeys) ?? MODULE_ENTRY_FALLBACK
}

/** The stored choice an action loads with: an override row, or nothing. */
export function choiceFromResolved(action: ResolvedAction): OverrideChoice {
  if (action.source !== 'employee_override') return 'inherit'
  return action.allowed ? 'allow' : 'deny'
}

export function initialChoices(actions: readonly ResolvedAction[]): Map<string, OverrideChoice> {
  return new Map(actions.map(a => [a.actionKey, choiceFromResolved(a)]))
}

/** The effective allowed map, folding pending choices over what the resolver said. */
export function effectiveMap(
  actions: readonly ResolvedAction[],
  choices: ReadonlyMap<string, OverrideChoice>,
): Record<string, boolean> {
  const map: Record<string, boolean> = {}
  for (const action of actions) {
    const choice = choices.get(action.actionKey) ?? 'inherit'
    map[action.actionKey] = choice === 'inherit' ? action.allowed : choice === 'allow'
  }
  return map
}

/**
 * THE WRITE RULE. Given what the administrator wants every action of a module
 * to be, the override choice per action: an explicit allow/deny — except for
 * an action that has no employee override today whose inherited value already
 * matches, which stays 'inherit' so no needless row is created.
 */
export function choicesForDesired(
  actions: readonly ResolvedAction[],
  desired: Readonly<Record<string, boolean>>,
): Map<string, OverrideChoice> {
  const next = new Map<string, OverrideChoice>()
  for (const action of actions) {
    const want = desired[action.actionKey] === true
    const hasExistingOverride = action.source === 'employee_override'
    if (!hasExistingOverride && want === action.allowed) next.set(action.actionKey, 'inherit')
    else next.set(action.actionKey, want ? 'allow' : 'deny')
  }
  return next
}

/** Only what changed, in the shape the PUT accepts. 'inherit' becomes null (revoke the override). */
export function changesBetween(
  moduleKey: string,
  actions: readonly ResolvedAction[],
  initial: ReadonlyMap<string, OverrideChoice>,
  next: ReadonlyMap<string, OverrideChoice>,
): OverrideChange[] {
  const out: OverrideChange[] = []
  for (const action of actions) {
    const choice = next.get(action.actionKey)
    if (!choice || choice === initial.get(action.actionKey)) continue
    out.push({
      moduleKey,
      actionKey: action.actionKey,
      allowed: choice === 'inherit' ? null : choice === 'allow',
    })
  }
  return out
}

export function levelOf(actions: readonly ResolvedAction[], effective: Record<string, boolean>): AccessLevel {
  return detectAccessLevel(actions.map(a => a.actionKey), effective)
}

// ── Where access comes from, in one label ───────────────────────────────────

export const SOURCE_LABEL: Record<PermissionSource, string> = {
  employee_override: 'Employee override',
  department: 'Department default',
  role: 'Role default',
  system_default: 'System default',
}

export type SourceSummary =
  | { kind: 'single'; source: PermissionSource; label: string }
  | { kind: 'mixed' }

/**
 * A module-level rollup of the per-action sources. A pending allow/deny always
 * reads as an employee override; reverting an existing override to 'inherit'
 * cannot be resolved without a save round trip and so folds into "mixed".
 * Without a pending map, choices are read as loaded (an override row reads as
 * an override).
 */
export function summarizeSources(
  actions: readonly ResolvedAction[],
  getChoice?: (actionKey: string) => OverrideChoice,
): SourceSummary {
  const loaded = initialChoices(actions)
  const choiceOf = getChoice ?? ((k: string) => loaded.get(k) ?? 'inherit')
  const sources = actions.map(a => {
    const choice = choiceOf(a.actionKey)
    if (choice !== 'inherit') return 'employee_override' as const
    if (a.source !== 'employee_override') return a.source
    return 'unknown' as const
  })
  const only = sources[0]
  if (sources.length > 0 && only !== 'unknown' && sources.every(s => s === only)) {
    return { kind: 'single', source: only, label: SOURCE_LABEL[only] }
  }
  return { kind: 'mixed' }
}

// ── Protected permissions, named in plain words ─────────────────────────────
//
// "assign" on its own does not tell an administrator what they are about to
// take away from somebody, so a confirmation names the authority in full.

export const PROTECTED_ACTION_WORDS: Record<string, string> = {
  assign:                'Assign assets',
  manage:                'Manage',
  delete:                'Delete',
  admin:                 'Admin',
  dispatch:              'Dispatch',
  receive:               'Receive',
  mark_lost:             'Mark lost',
  close:                 'Close',
  // can_be_order_assignee is NOT here. It named Order Request assignees, and
  // the module no longer registers it — an entry would label an option that is
  // never offered. A grant made before the retirement is not deleted; it is
  // simply read by nothing.
  view_quotations:       'View quotations and quoted prices',
  manage_quotations:     'Manage quotations',
  // Assets & Access. Named in full because "manage access records" on its own
  // does not tell an administrator that they are about to hand over — or take
  // back — every employee's login records.
  manage_access_records: 'Manage access records for all employees',
  // Customer Review Outreach. `use` is not protected — it is that module's
  // entry — so only the sign-off authority needs naming here.
  verify:                'Verify and close customer review requests',
  // One action key registered against two modules, so the words have to come
  // from the module being edited rather than from this map alone — see
  // protectedActionWords, which takes the module key for exactly this reason.
  view_all:              'View all records',
  approve_order:             'Approve order submissions',
  approve_advance_exception: 'Approve advance exceptions',
  allocate:                  'Allocate payments',
  allocate_correct:          'Correct payment allocations',
}

/** `view_all` means something different in Orders than in Finance. */
export const MODULE_SCOPED_ACTION_WORDS: Record<string, Record<string, string>> = {
  orders:  { view_all: 'View all company orders' },
  finance: { view_all: 'View all company payments and finance information' },
}

export function protectedActionWords(actionKeys: readonly string[], moduleKey?: string): string {
  const scoped = moduleKey ? MODULE_SCOPED_ACTION_WORDS[moduleKey] : undefined
  const names = actionKeys.map(k => scoped?.[k] ?? PROTECTED_ACTION_WORDS[k] ?? k)
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
