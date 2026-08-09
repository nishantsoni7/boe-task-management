// Who takes part in Attendance & Payroll — stated once, for both modules.
//
// WHY THIS FILE EXISTS
// --------------------
// BOE has accounts that must stay live in the operating system but must not be
// paid or measured: dummy logins, family members, non-salaried users, anyone
// whose attendance is deliberately not tracked. Deactivating the account is the
// wrong instrument — it takes away Tasks, Meetings and login along with payroll.
//
// The flag for this ALREADY EXISTS. `users.payroll_active` has been on the table
// since migration 20260607000100, defaults to true, and payroll generation has
// always honoured it. What did not exist was any attendance surface honouring
// it: /api/attendance/dashboard and /api/attendance/monthly-summary both
// selected on `is_active` alone, so an excluded member still appeared in the
// headcount and still accumulated absences in the warning counts.
//
// So this module adds no column and no second source of truth. It names the one
// that decides, and gives both modules the same predicate and the same query
// filter, so the rule cannot be spelled two ways in two places.
//
// WHAT EXCLUSION DOES NOT DO
// --------------------------
//   * It does not touch the account. is_active, role, Tasks and every unrelated
//     module are untouched, which is the entire point.
//   * It does not delete or rewrite history. Payroll results and attendance rows
//     already generated stay exactly as they are, including locked periods.
//   * It does not stop the biometric import. Punches keep landing in
//     attendance_records, so re-including someone restores a complete history
//     with no re-upload. Exclusion is about what is CALCULATED and COUNTED, not
//     about what is recorded.

/** The column that decides participation. There is only one, and this is it. */
export const PARTICIPATION_COLUMN = 'payroll_active'

/**
 * The fields the decision reads.
 *
 * Both are optional because callers select different column sets — a row that
 * omits `payroll_active` has not been asked about it, and the safe reading of a
 * missing value is the column default (true), matching every row written before
 * the flag existed.
 */
export type ParticipationRow = {
  payroll_active?: boolean | null
  is_deleted?: boolean | null
}

/**
 * Whether this member takes part in Attendance & Payroll.
 *
 * `payroll_active` is NOT NULL DEFAULT true in the database, so null/undefined
 * here means "not selected" rather than "excluded" — treating it as exclusion
 * would silently drop everybody from any query that forgot the column.
 * A soft-deleted row never participates whatever the flag says.
 */
export function participatesInPayroll(user: ParticipationRow | null | undefined): boolean {
  if (!user) return false
  if (user.is_deleted === true) return false
  return user.payroll_active !== false
}

/**
 * Split a set of members into those payroll may process and those it may not.
 *
 * Used by generation, which has to do more than drop the excluded ones — it
 * reports them, so an admin who named an excluded employee explicitly is told
 * why nothing was produced rather than being shown a silently shorter list.
 */
export function partitionByParticipation<T extends ParticipationRow>(
  users: T[],
): { included: T[]; excluded: T[] } {
  const included: T[] = []
  const excluded: T[] = []
  for (const u of users) (participatesInPayroll(u) ? included : excluded).push(u)
  return { included, excluded }
}

/**
 * The same restriction, applied in the database rather than after the read.
 *
 * Structural typing rather than a Supabase import: this takes any builder with
 * `.eq()`, which keeps the module free of a client dependency and — more
 * usefully — makes the filter testable with a two-line fake instead of a live
 * connection. Every attendance and payroll read that must not see excluded
 * members goes through this, so "did we remember the filter?" is one grep.
 */
export function onlyParticipating<Q extends object>(query: Q): Q {
  return (query as unknown as ParticipationFilterable<Q>).eq(PARTICIPATION_COLUMN, true)
}

/**
 * Anything with an `.eq()` that hands back a chainable query.
 *
 * Q is inferred from the ARGUMENT and the cast is internal, which is the only
 * arrangement of this that compiles. Both natural spellings — a self-referential
 * constraint (`Q extends { eq(...): Q }`) and inferring Q from the return type —
 * make the compiler resolve Q against Supabase's builder, which returns `this`
 * on an already deeply generic type; it gives up with TS2589 "type instantiation
 * is excessively deep", and did so here for real. Supabase's `.eq()` returns the
 * same builder it was called on, so returning Q is accurate at runtime.
 */
type ParticipationFilterable<Q> = { eq(column: string, value: unknown): Q }

// ─── Confirmation copy ────────────────────────────────────────────────────────
// Written here, beside the rule, so the sentence an admin reads before excluding
// somebody describes what this module actually does.

export function excludeConfirmTitle(employeeName: string): string {
  return `Exclude ${employeeName} from Attendance & Payroll?`
}

export const EXCLUDE_CONFIRM_BODY =
  'Future attendance and payroll calculations will ignore this member. ' +
  'Existing historical records will remain unchanged.'

export function includeConfirmTitle(employeeName: string): string {
  return `Include ${employeeName} in Attendance & Payroll again?`
}

export const INCLUDE_CONFIRM_BODY =
  'This member will be counted in future attendance processing and included the ' +
  'next time payroll is generated. Payroll already generated is not changed.'
