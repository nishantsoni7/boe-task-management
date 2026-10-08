import { entryActionForModule } from './levels'

// Giving a whole TEAM (department) access to a module, from Control Center.
//
// The permission engine already resolves, in this order: Employee Override >
// Department > Role > System Default (20260660). Until now only employee
// overrides had a screen; department rules existed only where a migration had
// seeded them. This is the screen's rule set, shared by the route that writes
// it and the panel that shows it, so they cannot disagree.
//
// WHAT A TEAM RULE IS, AND IS NOT
//   * It sets ONE action — the module's entry action (`view` or `use`): "may this
//     team open the module". It never touches any other action, so it cannot
//     hand out a protected one (the preset levels and By Employee keep that).
//   * allow   → the team may open the module.
//   * block   → the team may not, unless an individual override says otherwise.
//   * inherit → no team rule; the role / system default decides (no row).
//   * An individual's own override always wins over the team's rule, and a system
//     Administrator's authority is users.role — a team rule neither adds to it nor
//     takes it away.

export type TeamAccessState = 'allow' | 'block' | 'inherit'
export const TEAM_ACCESS_STATES: readonly TeamAccessState[] = ['allow', 'block', 'inherit']

export const TEAM_ACCESS_LABELS: Record<TeamAccessState, { label: string; hint: string }> = {
  allow: { label: 'Allowed', hint: 'Everyone in this team can open the module.' },
  inherit: { label: 'Not set', hint: 'No team rule — the default decides.' },
  block: { label: 'Blocked', hint: 'Nobody in this team can open it, unless given access individually.' },
}

/** The one action a team rule is written for, or null when the module has none to grant. */
export function teamRuleAction(moduleActionKeys: readonly string[]): string | null {
  return entryActionForModule(moduleActionKeys)
}

export function stateFromStored(allowed: boolean | null | undefined): TeamAccessState {
  if (allowed === true) return 'allow'
  if (allowed === false) return 'block'
  return 'inherit'
}

export type TeamAccessChange = { departmentKey: string; state: TeamAccessState }

/** Parses a request body into changes, or says why it cannot. Never throws. */
export function parseTeamChanges(body: unknown): { ok: true; changes: TeamAccessChange[] } | { ok: false; error: string } {
  const raw = (body as { changes?: unknown } | null)?.changes
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'No changes provided' }
  if (raw.length > 100) return { ok: false, error: 'Too many changes in one request' }
  const seen = new Set<string>()
  const changes: TeamAccessChange[] = []
  for (const c of raw) {
    const key = (c as { departmentKey?: unknown })?.departmentKey
    const state = (c as { state?: unknown })?.state
    if (typeof key !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(key)) return { ok: false, error: 'Invalid department' }
    if (typeof state !== 'string' || !(TEAM_ACCESS_STATES as readonly string[]).includes(state)) return { ok: false, error: 'Invalid access state' }
    if (seen.has(key)) return { ok: false, error: 'A department was listed twice' }
    seen.add(key)
    changes.push({ departmentKey: key, state: state as TeamAccessState })
  }
  return { ok: true, changes }
}

/** What a salesperson-facing sentence says about a team's rule, for the summary line. */
export function describeTeamRules(rules: readonly { name: string; state: TeamAccessState }[]): string {
  const allowed = rules.filter(r => r.state === 'allow').map(r => r.name)
  const blocked = rules.filter(r => r.state === 'block').map(r => r.name)
  const parts: string[] = []
  if (allowed.length) parts.push(`Allowed for ${allowed.join(', ')}`)
  if (blocked.length) parts.push(`blocked for ${blocked.join(', ')}`)
  return parts.length ? parts.join('; ') + '.' : 'No team has a rule — only individuals you add below, and administrators, can open it.'
}
