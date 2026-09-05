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

/**
 * The blocking message for an operation that would remove the last
 * administrator, or null when the operation is safe.
 *
 * Returns null immediately — without a count — when the target is not an
 * administrator account, so deactivating an ordinary employee never pays for
 * this check and can never be refused by it.
 */
export async function lastAdministratorBlock(
  supabase: SupabaseClient,
  target: AdministratorRow | null | undefined,
  targetUserId: string,
  action: AdministratorAction,
): Promise<string | null> {
  if (!targetCarriesAdministratorAuthority(target, action)) return null

  const remaining = await otherUsableAdministratorCount(supabase, targetUserId)
  if (remaining > 0) return null

  return (
    `This is the last administrator account, so you cannot ${ACTION_PHRASE[action]}. ` +
    'Give another active member the Administrator system role first — or reactivate ' +
    'an existing administrator — and then try again. Without one, nobody would be ' +
    'able to manage BOE.'
  )
}
