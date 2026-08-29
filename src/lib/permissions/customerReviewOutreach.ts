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
// ADMINS DO NOT BYPASS THE ENGINE FOR `use`, and this module is deliberately
// unlike the other cut-over modules in that one respect.
//
// The reason is that `use` is the only permission here whose database side has
// no administrator branch at all. book_customer_review_test_card() asks
// resolve_permission(uid, 'customer_review_requests', 'use') and nothing else,
// so an administrator whose `use` was revoked in Control Center is refused
// 42501 — while a blanket `role === 'admin'` here would still have drawn them
// a Book button. That is precisely the failure this module's first rule
// forbids: a button must never appear for a permission its RPC will refuse.
//
// It costs an administrator nothing they should have. The role_permissions
// seed grants admin both actions, so resolve_permission answers true for them
// by default; the only case that changes is the one where somebody deliberately
// took the permission away, which is what taking it away is for.

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
   * May verify a submitted test and return one to its tester. Independent of
   * `canUse` in one direction: a verifier who does not hold `use` can check
   * everybody's tests but cannot book one — which is the separation the
   * workflow exists to exercise.
   *
   * NOT "and read the history of verified ones". There is no history screen:
   * once a card is verified it appears in no frontend list, and this capability
   * grants nothing over a finished card.
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
  const allowed = (actionKey: string) =>
    permissions.some(p => p.actionKey === actionKey && p.allowed)

  // CANDIDATE AUTHORITY IS THE RESOLVED PERMISSION, FOR EVERYBODY.
  //
  // The whole `if (role === 'admin') return { …all true }` short-circuit that
  // stood at the top of this function is gone. It made every administrator a
  // candidate: Book on the list, and on a card they held, WhatsApp, the
  // screenshot controls, Confirm sent and Submit. For an administrator with
  // `use` that was merely redundant. For one whose `use` had been revoked it
  // drew controls the database refuses, which is the mismatch this module
  // exists to avoid.
  //
  // Ownership is unaffected either way — holdsThisCard() and the definer
  // functions have required booked_by = the actor since the previous
  // correction, and none of that is loosened or tightened here. This is about
  // what a screen OFFERS, not about what the database ALLOWS.
  const canUse = allowed('use')

  // VERIFIER AUTHORITY STILL ADMITS AN ADMINISTRATOR, which is the asymmetry
  // worth stating rather than leaving to be discovered.
  //
  // Verifying and returning are the two things an administrator is expected to
  // be able to do here without a per-employee grant, and the seed gives them
  // `verify` anyway. See the note in the module documentation: an administrator
  // whose `verify` is explicitly revoked would still be offered Verify and
  // still be refused by transition_customer_review_test_card(), so this branch
  // is a smaller version of the same mismatch, kept because removing it was not
  // part of the correction that was asked for.
  const canVerify = allowed('verify') || role === 'admin'

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
