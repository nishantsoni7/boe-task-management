import type { SupabaseClient } from '@supabase/supabase-js'

// THE LAST-ADMINISTRATOR INVARIANT.
//
// One rule, enforced on every path that can take somebody's administrator
// authority away:
//
//   AN OPERATION MAY NOT LEAVE THE ORGANISATION WITHOUT AT LEAST ONE
//   ADMINISTRATOR WHO IS ACTIVE AND NOT DELETED.
//
// WHY THIS HAS TO BE CENTRAL. `users.role = 'admin'` is the only authority that
// can hand `users.role = 'admin'` back. Every RLS policy in this schema tests
// it, the permission engine short-circuits on it, and the Control Center — the
// only screen that can edit an employee at all — admits nobody else. Lose the
// last one and there is no route back inside the application; the organisation
// would need somebody with the service-role key and a SQL console.
//
// FOUR PATHS REACH THAT STATE, NOT ONE. The first version of this guard lived
// inline in /api/update-member and covered role demotion only, which left the
// lockout wide open:
//
//   1. demote            update-member sets role away from 'admin'
//   2. deactivate        toggle-active sets is_active = false
//   3. soft delete       delete-user   sets is_deleted = true
//   4. permanent delete  permanently-delete-user removes the row
//
// Deactivate → soft delete was the specific chain: deactivating the final
// administrator was allowed, and delete-user then accepted them precisely
// BECAUSE they were inactive. Guarding demotion alone stopped none of it.
//
// WHAT COUNTS AS A REMAINING ADMINISTRATOR — and why `is_active` is in the test
// -----------------------------------------------------------------------------
// `is_active` is not an authentication gate in this application: Supabase Auth
// knows nothing about it, so a deactivated administrator can still sign in, and
// the role-only checks in the RLS policies would still admit them. By that
// reading, a deactivated administrator is "usable" and counting them would be
// defensible.
//
// This deliberately takes the STRICTER reading, for three reasons:
//
//   * it is the direction that fails safe. Over-counting means a lockout;
//     under-counting means one extra step for an administrator, and the error
//     message says exactly which step.
//   * the repository already draws the line here on its most destructive
//     routes — src/app/api/orders/test-data-cleanup and test-data-reset both
//     require `role === 'admin' && is_active !== false && is_deleted !== true`.
//     One definition of "a real administrator" is better than two.
//   * a deactivated administrator is a contradiction the business has said it
//     does not want: deactivation is how BOE says somebody has left. Relying on
//     their continued ability to sign in would make the invariant depend on a
//     gap nobody intends to keep.
//
// A soft-deleted administrator never counts. The organisation has said they are
// gone, and `/api/admin-members` already refuses to list them.
//
// THIS IS NOT THE ONLY GUARD ON THESE ROUTES. Each one independently verifies
// from its bearer token that the caller is an administrator before reaching
// here, and RLS decides the data. This adds the one question those checks do
// not ask: not "may you do this", but "will anyone be left who can".

/** The shape each route already reads, or can read, for its target. */
export type AdministratorRow = {
  role?: string | null
  is_active?: boolean | null
  is_deleted?: boolean | null
}

/** The four operations this invariant protects, for the message each needs. */
export type AdministratorAction = 'demote' | 'deactivate' | 'delete' | 'permanently_delete'

/**
 * Whether this row carries administrator authority that `action` would remove.
 *
 * `is_deleted !== true` rather than `=== false` throughout: the column is
 * nullable and legacy rows predate it, so NULL means "not deleted".
 *
 * PERMANENT DELETION IS THE EXCEPTION, and it is not a detail. Every row
 * reaching that route is soft-deleted already, so testing `is_deleted !== true`
 * there would reject every target and the guard would be dead code that reads
 * as protection. A soft-deleted administrator still carries RECOVERABLE
 * authority — restore them, reactivate them, and BOE has an administrator
 * again — and permanent deletion is precisely the step that ends that. So a
 * deleted row still counts as an administrator account when the question is
 * whether to destroy it for good.
 */
export function targetCarriesAdministratorAuthority(
  row: AdministratorRow | null | undefined,
  action: AdministratorAction,
): boolean {
  if (!row || row.role !== 'admin') return false
  if (action === 'permanently_delete') return true
  return row.is_deleted !== true
}

/**
 * How many administrators OTHER than `excludingUserId` are active and not
 * deleted — the people who would still be able to administer BOE if this
 * operation went through.
 *
 * Counted with a HEAD request, so no employee row crosses the wire to answer a
 * question that only needs a number.
 */
export async function otherUsableAdministratorCount(
  supabase: SupabaseClient,
  excludingUserId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'admin')
    .eq('is_active', true)
    .or('is_deleted.eq.false,is_deleted.is.null')
    .neq('id', excludingUserId)

  // FAIL CLOSED. A count we could not take is not evidence that somebody else
  // is left, and this is the one question where guessing "yes" is the
  // unrecoverable answer.
  if (error) throw error
  return count ?? 0
}

const ACTION_PHRASE: Record<AdministratorAction, string> = {
  demote:            'change this account’s system role',
  deactivate:        'deactivate this account',
  delete:            'delete this account',
  permanently_delete:'permanently delete this account',
}

/** What a route should do next: proceed, or send exactly this response. */
export type AdministratorCheck =
  | { ok: true }
  | { ok: false; status: number; error: string }

/**
 * THE ONE ENTRY POINT. Reads the target itself, decides, and tells the caller
 * either "proceed" or the exact response to send.
 *
 * IT OWNS THE READ ON PURPOSE. The first version took a target row the route
 * had already fetched, and two of the four routes fetched it while discarding
 * the query's error. A failed read produced `null`, `null` looked exactly like
 * "not an administrator", and the guard waved the write through — fail-open, in
 * the one place that must fail closed. Both call sites made the same mistake,
 * which is the signature of an API that invites it rather than two careless
 * edits.
 *
 * So the read moved in here. A route cannot forget to check an error it never
 * sees, and a future fifth caller inherits the correct behaviour by default.
 * The cost is one small SELECT on the two routes that already hold the row for
 * their own checks; that is a fair price for deleting a class of bug.
 *
 * EVERY FAILURE PATH STOPS THE REQUEST:
 *   target unreadable   → 500, nothing changed
 *   target missing      → 404
 *   count unreadable    → 500, nothing changed
 *   last administrator  → 400 with the message the administrator needs
 *
 * The only `ok: true` results are "this target carries no administrator
 * authority" and "somebody else can still administer BOE".
 */
export async function checkLastAdministrator(
  supabase: SupabaseClient,
  targetUserId: string,
  action: AdministratorAction,
): Promise<AdministratorCheck> {
  const { data: target, error: targetError } = await supabase
    .from('users')
    .select('role, is_active, is_deleted')
    .eq('id', targetUserId)
    .single()

  if (targetError) {
    // PGRST116 is PostgREST's "no rows" for .single() — a genuinely missing
    // member, which is a 404. Anything else is a read we could not complete,
    // and an unanswerable question must never be read as "go ahead".
    if (targetError.code === 'PGRST116') {
      return { ok: false, status: 404, error: 'Member not found' }
    }
    return {
      ok: false,
      status: 500,
      error: 'Could not check whether this member is the last administrator, so nothing was changed. Please try again.',
    }
  }

  if (!target) return { ok: false, status: 404, error: 'Member not found' }

  // Not an administrator: nothing to protect, and no count is taken. An
  // ordinary employee can never be refused by this check.
  if (!targetCarriesAdministratorAuthority(target as AdministratorRow, action)) return { ok: true }

  let remaining: number
  try {
    remaining = await otherUsableAdministratorCount(supabase, targetUserId)
  } catch {
    return {
      ok: false,
      status: 500,
      error: 'Could not check whether another administrator remains, so nothing was changed. Please try again.',
    }
  }

  if (remaining > 0) return { ok: true }

  return {
    ok: false,
    status: 400,
    error:
      `This is the last administrator account, so you cannot ${ACTION_PHRASE[action]}. ` +
      'Give another active member the Administrator system role first — or reactivate ' +
      'an existing administrator — and then try again. Without one, nobody would be ' +
      'able to manage BOE.',
  }
}
