// Order Approval — the one permission, and the one account that holds it
// permanently.
//
// WHAT THIS FILE IS, AND WHAT IT IS NOT
//
// It is NOT a second permission system, and it introduces no new vocabulary.
// Order Approval is `orders.approve_order`, registered by 20260908000000,
// listed in PROTECTED_ACTIONS in levels.ts, resolved by the same four-level
// engine as every other action, and enforced in the database by
// actor_has_module_permission('orders', 'approve_order') inside every review
// door. Nothing here decides anything: the database decides, and it decides
// again on every call.
//
// What this file holds is the ONE FACT that cannot be derived from the engine —
// that a specific seeded account's grant is not the administrator's to take
// away — plus the wording for refusing an attempt to take it. The same fact is
// stated in SQL by public.is_permanent_order_approver(uuid)
// (20261224000000 §1), and orderApproval.test.ts asserts the two agree.
//
// WHY A SEEDED ACCOUNT AT ALL. Because a permission nobody can be certain of
// holding is a permission the business cannot rely on. Every review door in
// Orders refuses a caller without approve_order, so an account that could be
// denied it — by accident, in a bulk edit, or by somebody correcting the wrong
// row — is an account that can lock the company out of approving its own
// orders. One account is therefore pinned, and exactly one.
//
// WHY employee_code AND NOT A uuid. This is the convention 20260697000000
// established for named exceptions and the reason it gave still holds: a uuid
// in source is unreadable and unverifiable, and full_name is neither unique nor
// stable. employee_code is the identifier the rest of the permission history
// resolves named people by.

/** The Access Control module Order Approval belongs to. */
export const ORDERS_MODULE_KEY = 'orders'

/**
 * Order Approval, as the engine spells it.
 *
 * Deliberately NOT `approve`. That key means "convert an Order Request" and is
 * checked by a different set of functions; reusing it would have handed PI
 * approval to everyone holding the older authority. See modules.ts, where the
 * action is registered with the label an administrator reads —
 * "Approve PI / Confirm Order".
 */
export const ORDER_APPROVAL_ACTION_KEY = 'approve_order'

/**
 * The accounts whose Order Approval grant is permanent.
 *
 * MIRRORS public.is_permanent_order_approver(uuid). A change here without the
 * matching change in a migration is a lie the screen tells about what the
 * database will accept, so orderApproval.test.ts reads the SQL and compares.
 *
 *   TEST-001 — Nishant, the owner/administrator account.
 */
export const PERMANENT_ORDER_APPROVER_CODES: readonly string[] = ['TEST-001']

export function isPermanentOrderApprover(employeeCode: string | null | undefined): boolean {
  if (!employeeCode) return false
  return PERMANENT_ORDER_APPROVER_CODES.includes(employeeCode)
}

/**
 * THE ACTIONS THAT ARE STILL WORTH EDITING ON AN ADMINISTRATOR.
 *
 * Both Control Centre views render a system Administrator's row read-only, and
 * the banner explains why: "an override saved here could neither add to their
 * authority nor reduce it." That was true of every action, because
 * actor_has_module_permission answers yes to an active admin before it ever
 * consults the resolver.
 *
 * It stopped being true of exactly one action. 20261224000000 §4 gave
 * orders.approve_order a permission-only door — actor_can_approve_order(),
 * with no role branch — precisely so the owner CAN withdraw PI approval from
 * an administrator. Leaving the row locked would mean the database supports a
 * decision the screen refuses to let anybody make.
 *
 * So the lock gains an exception, and the exception is a list of one. Anything
 * added here must have a matching permission-only door in the database, or the
 * screen goes back to offering a control that decides nothing.
 */
export const ADMIN_EDITABLE_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  [ORDERS_MODULE_KEY]: [ORDER_APPROVAL_ACTION_KEY],
}

/** The actions of `moduleKey` an administrator's row may still be edited for. */
export function adminEditableActions(moduleKey: string): readonly string[] {
  return ADMIN_EDITABLE_ACTIONS[moduleKey] ?? []
}

export function isAdminEditableAction(moduleKey: string, actionKey: string): boolean {
  return adminEditableActions(moduleKey).includes(actionKey)
}

/** Whether an administrator's row for this module is editable at all. */
export function moduleHasAdminEditableActions(moduleKey: string): boolean {
  return adminEditableActions(moduleKey).length > 0
}

/** One entry of the Access Control PUT payload. `null` means revert to inherited. */
export type PermissionChange = {
  moduleKey: string
  actionKey: string
  allowed: boolean | null
}

/** Whether a pending change is about Order Approval at all. */
export function targetsOrderApproval(change: PermissionChange): boolean {
  return change.moduleKey === ORDERS_MODULE_KEY
    && change.actionKey === ORDER_APPROVAL_ACTION_KEY
}

/**
 * Whether a change would take Order Approval AWAY.
 *
 * Two shapes do, and they are not the same thing to the resolver:
 *   allowed === false  an explicit deny override
 *   allowed === null   revert to inherited, which soft-revokes the row
 *
 * `allowed === true` is a re-grant and is always fine — re-asserting what is
 * already true is not an attack and must not be an error.
 */
export function removesOrderApproval(change: PermissionChange): boolean {
  return targetsOrderApproval(change) && change.allowed !== true
}

/**
 * The refusal, in the words the administrator sees.
 *
 * Says what was refused, why, and what is still possible — an administrator who
 * came here to change somebody's access should leave knowing they can, just not
 * this person's.
 */
export const PERMANENT_ORDER_APPROVAL_REFUSAL =
  'Order Approval cannot be removed from the owner account. This permission is permanently held there so the company can never be locked out of approving its own orders. It can still be granted to, or withdrawn from, anyone else.'

/**
 * The refusal for a set of pending changes, or null if none of them takes the
 * permanent grant away.
 *
 * Pure, and deliberately separate from the route: the route supplies WHO the
 * employee is, this decides what may be done to them, and the test can ask the
 * question without a database.
 */
export function refusePermanentOrderApprovalRemoval(
  employeeCode: string | null | undefined,
  changes: readonly PermissionChange[],
): string | null {
  if (!isPermanentOrderApprover(employeeCode)) return null
  return changes.some(removesOrderApproval) ? PERMANENT_ORDER_APPROVAL_REFUSAL : null
}
