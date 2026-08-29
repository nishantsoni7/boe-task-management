import type { EffectivePermission } from './types'
import type { TestCard } from '@/lib/customerReviews/types'

// Review Workflow Test (Internal) — capability derivation.
//
// One place that turns the raw effective permissions for the
// 'customer_review_requests' module into the booleans the guard, the launcher
// card and the screens branch on, so the UI and the database say the same
// thing. Every capability maps to exactly one action, and every button maps to
// exactly one capability — a button must never appear for a permission its RPC
// will refuse.
//
// THE MODULE KEY IS UNCHANGED AND THAT IS DELIBERATE. This module's purpose
// changed; its permission identifiers did not. `customer_review_requests` with
// `use` and `verify` is what every existing Control Center grant is written
// against, and renaming the key to match the new display name would silently
// revoke all of them. The key is an identifier; the display name is the part a
// human reads, and that is what changed.
//
// TWO ACTIONS, AND THE MODULE REGISTERS NO `view`.
//
// That is the decision worth stating, because every other cut-over module here
// gates entry on `view` (see moduleVisibility.ts). It does not apply:
//
//   `use`    IS module entry. There is no read-only audience for this module —
//            a `use` holder sees the available pool and THEIR OWN booked tests
//            and nobody else's, so a "can open it but can do nothing" grant
//            would name an empty screen. Adding `view` to make the shape
//            uniform would have created a third permission that grants nothing,
//            which is worse than the asymmetry.
//
//   `verify` is the authority to say a test was actually checked, and to hand
//            one back. It is PROTECTED (see levels.ts): nobody should acquire
//            "I confirm this workflow was exercised correctly" by picking a
//            level from a dropdown. It depends on `use` (ACTION_DEPENDENCIES),
//            so a verifier can always open the module.
//
// The consequence for Control Center is real and is handled: the module's
// on/off toggle reads `use` rather than `view` for this one module, because it
// resolves the entry action from what the module registers — see
// entryActionForModule() in ./levels and entryActionFor() in
// src/app/admin/control-center/permissions/page.tsx.
//
// Admins bypass the engine entirely, matching every other cut-over module.

export type CustomerReviewCapabilities = {
  /** May open the module at all. `use` OR `verify` — see below. */
  canAccessModule: boolean
  /**
   * May book an available test card, open WhatsApp for one they hold, confirm
   * they sent it, attach a screenshot and submit it for verification.
   *
   * All of that is ONE authority on purpose. Splitting "book" from "submit"
   * would produce a tester who can take a card and never hand it back, and
   * every one of those steps is already scoped to the card that tester holds.
   */
  canUse: boolean
  /**
   * May verify a submitted test, return one to its tester, and read the history
   * of verified ones. Independent of `canUse` in one direction: a verifier who
   * does not hold `use` can check everybody's tests but cannot book one — which
   * is the separation the workflow exists to exercise.
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
    // implies it — a verifier who could not open the module could not verify
    // anything. ACTION_DEPENDENCIES already normalises a Custom save to include
    // `use`; this is the read-time half, for a grant made before that rule or
    // written directly.
    canAccessModule: canUse || canVerify,
    canUse,
    canVerify,
  }
}

/**
 * Whether this person is the tester currently holding this card — the
 * browser-side mirror of the ownership half of the definer functions in
 * migration 20261017000000 §8.
 *
 * NOT an editorship check, because nothing in this module is editable. Card
 * text is fixture-loaded and no client role holds INSERT or UPDATE on the table
 * at all, so there is no "may I change this" question to answer. The only
 * question a screen has is "is this mine to act on", which is this.
 *
 * THERE IS NO ADMINISTRATOR BRANCH, and its removal is the point. An earlier
 * version returned true for any admin, on the argument that somebody has to be
 * able to unstick a card whose tester has left. That argument turned every
 * tester action into something an administrator could perform on somebody
 * else's test — opening WhatsApp as them, confirming a send they did not make,
 * submitting evidence they did not produce. An administrator's authority here
 * covers verifying and returning, and the way to unstick a card is to RETURN
 * it, which a verifier can already do.
 *
 * The role parameter is gone from the signature rather than accepted and
 * ignored, so a caller cannot pass one and believe it counts for something.
 */
export function holdsThisCard(
  card: Pick<TestCard, 'booked_by'>,
  userId: string | null | undefined,
  caps: CustomerReviewCapabilities,
): boolean {
  if (!userId) return false
  return card.booked_by === userId && caps.canUse
}
