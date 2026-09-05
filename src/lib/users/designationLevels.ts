// BOE's employee organisational hierarchy — the six rungs, and nothing else.
//
// THE SEPARATION THIS FILE EXISTS TO HOLD
// ---------------------------------------
// Four different facts about an employee were previously blurred into one word,
// "role". They are kept apart here and in the UI:
//
//   Department         users.team      which functional group they work in
//   Designation        users.position  their job title ("Senior Designer")
//   Designation Level  users.designation_level   the rung below
//   System Access      users.role + the permission engine
//
// A LEVEL GRANTS NOTHING. Nothing in this file is consulted by any route guard,
// RLS policy, resolver or permission check, and nothing may start consulting it
// without that being designed as a privilege change. `users.role` and the
// permission engine remain the only answer to "may this person do that" — see
// the header of supabase/migrations/20261106000000_employee_designation_level.sql.
//
// The consequence worth stating plainly: a Manager in Design is a Manager in
// Design. It does not give them Finance.

export const DESIGNATION_LEVELS = [
  'super_admin',
  'administrator',
  'manager',
  'executive',
  'assistant',
  'trainee',
] as const

export type DesignationLevel = (typeof DESIGNATION_LEVELS)[number]

/** Ordered most senior first — the order the UI lists them in. */
export const DESIGNATION_LEVEL_LABELS: Record<DesignationLevel, string> = {
  super_admin:   'Super Admin',
  administrator: 'Administrator',
  manager:       'Manager',
  executive:     'Executive',
  assistant:     'Assistant',
  trainee:       'Trainee',
}

/**
 * The two rungs that name the organisation's administration.
 *
 * They are RESTRICTED in the sense that only a system administrator may set
 * them — which today is the same as saying only a system administrator may edit
 * an employee at all, because every member-management route already refuses
 * anybody else. The list is here so that stays true by name rather than by
 * coincidence if member editing is ever delegated.
 */
export const RESTRICTED_DESIGNATION_LEVELS: readonly DesignationLevel[] = [
  'super_admin',
  'administrator',
]

export function isDesignationLevel(value: unknown): value is DesignationLevel {
  return typeof value === 'string' && (DESIGNATION_LEVELS as readonly string[]).includes(value)
}

export function isRestrictedDesignationLevel(value: unknown): boolean {
  return isDesignationLevel(value) && RESTRICTED_DESIGNATION_LEVELS.includes(value)
}

/**
 * The label for a stored level, or null when it is unset or unrecognised.
 *
 * Null is a real answer: the column was deliberately not backfilled, so most
 * employees have no level until an administrator sets one. Callers render their
 * own placeholder rather than being handed a fake rung.
 */
export function designationLevelLabel(value: string | null | undefined): string | null {
  return isDesignationLevel(value) ? DESIGNATION_LEVEL_LABELS[value] : null
}

/** A department key ('sales') as a person would read it ('Sales'). */
export function departmentLabel(team: string | null | undefined): string | null {
  if (!team) return null
  return team
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * The one line of secondary text shown under an employee's name.
 *
 * ORDINARY EMPLOYEES MUST NEVER BE SHOWN `member`. That word is the
 * authorization role — a technical label that says nothing about the person's
 * job and reads, to the person, as a demotion. So this deliberately does not
 * take `role` at all: it cannot leak it.
 *
 * Job title first, because "Senior Designer" is what somebody calls themselves;
 * the rung stands in when no title is recorded; the department qualifies either.
 * With nothing recorded at all the result is an empty string, and the caller
 * renders no second line rather than a placeholder.
 */
export function employeeSubtitle(employee: {
  position?: string | null
  designation_level?: string | null
  team?: string | null
}): string {
  const lead = employee.position?.trim() || designationLevelLabel(employee.designation_level)
  const dept = departmentLabel(employee.team)
  return [lead, dept].filter(Boolean).join(' · ')
}
