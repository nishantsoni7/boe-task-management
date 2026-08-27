import type { EffectivePermission } from './types'

// Customer Review Outreach capability derivation.
//
// One place that turns the raw effective permissions for the
// 'customer_review_requests' module into the booleans the guard, the launcher
// card and the screens branch on, so the UI and the database say the same
// thing. Every capability maps to exactly one action, and every button maps to
// exactly one capability — a button must never appear for a permission its RPC
// will refuse.
//
// TWO ACTIONS, AND THE MODULE REGISTERS NO `view`.
//
// That is the decision worth stating, because every other cut-over module here
// gates entry on `view` (see moduleVisibility.ts). It does not apply:
//
//   `use`    IS module entry. There is no read-only audience for this module —
//            a `use` holder sees THEIR OWN outreach and nobody else's, so a
//            "can open it but can do nothing" grant would name an empty screen.
//            Adding `view` to make the shape uniform would have created a third
//            permission that grants nothing, which is worse than the asymmetry.
//
//   `verify` is the authority to say a review has actually been checked, and to
//            close the request. It is PROTECTED (see levels.ts): nobody should
//            acquire "I confirm this customer really reviewed us" by picking a
//            level from a dropdown. It depends on `use` (ACTION_DEPENDENCIES),
//            so a verifier can always open the module.
//
// The consequence for Control Center is real and is handled: the module's
// on/off toggle reads `use` rather than `view` for this one module — see
// MODULE_ENTRY_ACTION_OVERRIDES in
// src/app/admin/control-center/permissions/page.tsx.
//
// Admins bypass the engine entirely, matching every other cut-over module.

export type CustomerReviewCapabilities = {
  /** May open the module at all. `use` OR `verify` — see below. */
  canAccessModule: boolean
  /**
   * May raise a request, edit their own, mark it ready, open WhatsApp for it,
   * confirm they sent it, record a reply, record evidence, and cancel it.
   *
   * All of that is ONE authority on purpose. Splitting "create" from "send"
   * would produce an employee who can prepare an invitation and not deliver it,
   * which is not a real BOE role — and every one of those steps is already
   * scoped to the requests that employee raised.
   */
  canUse: boolean
  /**
   * May verify a request and close it. Independent of `canUse` in one
   * direction: a verifier who does not hold `use` can read and check every
   * request but cannot raise or send one.
   */
  canVerify: boolean
}

export const NO_CUSTOMER_REVIEW_CAPABILITIES: CustomerReviewCapabilities = {
  canAccessModule: false,
  canUse: false,
  canVerify: false,
}

export function deriveCustomerReviewCapabilities(
  role: string | null | undefined,
  permissions: readonly EffectivePermission[],
): CustomerReviewCapabilities {
  if (role === 'admin') {
    return { canAccessModule: true, canUse: true, canVerify: true }
  }

  const allowed = (actionKey: string) =>
    permissions.some(p => p.actionKey === actionKey && p.allowed)

  const canUse = allowed('use')
  const canVerify = allowed('verify')

  return {
    // Entry is the weakest thing this module grants, so the stronger authority
    // implies it — a verifier must be able to open the module they are meant to
    // check. ACTION_DEPENDENCIES already normalises a Custom save to include
    // `use`; this is the read-time half, for a grant made before that rule or
    // written directly.
    canAccessModule: canUse || canVerify,
    canUse,
    canVerify,
  }
}

/**
 * Whether this person may CHANGE this request — the browser-side mirror of
 * can_edit_customer_review_request() (migration 20261017000000 §5).
 *
 * Two narrowings, and both matter:
 *   * only while the request is still being prepared. Once it has been sent,
 *     what the customer received is a fact, and editing it afterwards would
 *     make the record a lie about what was sent.
 *   * only the employee who raised it, or an admin. A verifier reads every
 *     request and authors none of them.
 */
export function canEditThisRequest(
  request: { status: string; created_by: string },
  userId: string | null | undefined,
  caps: CustomerReviewCapabilities,
  role: string | null | undefined,
): boolean {
  if (!userId) return false
  if (request.status !== 'draft' && request.status !== 'ready_to_send') return false
  if (role === 'admin') return true
  return request.created_by === userId && caps.canUse
}
