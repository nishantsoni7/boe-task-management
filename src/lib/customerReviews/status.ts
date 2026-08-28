import type { TestCard, TestCardStatus } from './types'

// THE TRANSITION TABLE, and the prerequisites that guard the two moves that
// matter.
//
// This file is the browser's copy. The DECIDING copy is
// transition_customer_review_test_card() in
// supabase/migrations/20261017000000_customer_review_outreach.sql, which holds
// the identical table and re-checks it on every call. They are written to match
// deliberately: the UI must never offer a button whose RPC will refuse it, and
// the RPC must never accept a move the UI would not have offered.
//
// THE RULE THIS FILE EXISTS TO STATE: a status is a claim about something a
// PERSON did, and nothing below infers one from an event. In particular there
// is no transition FROM "the tester opened WhatsApp" TO anything at all —
// opening a link is not evidence that a message was sent, and the two are
// recorded by two different calls for exactly that reason. Booking is likewise
// its own call (bookTestCard / book_customer_review_test_card) rather than a
// transition, because it is the one move that must be atomic against a race
// between two testers.

/** Every legal move, by current status. An absent key is a terminal state. */
export const TEST_CARD_TRANSITIONS: Readonly<
  Record<TestCardStatus, readonly TestCardStatus[]>
> = {
  // Booking is NOT in this table. It happens through its own RPC, which claims
  // the row with a conditional UPDATE so two testers cannot both take one card.
  // Listing it here as an ordinary transition would invite a future caller to
  // route it through the generic function, which locks a row it has already
  // read — one lock too late to be a race guard.
  available: [],
  booked:    ['submitted'],
  // BACK TO 'booked' IS THE RETURN PATH, and it is the only backwards move in
  // the module. A verifier who cannot read the screenshot has to be able to
  // hand the card back; the alternatives are verifying evidence they could not
  // check, or leaving the card stuck in the queue forever. It needs `verify`
  // (see VERIFIER_ONLY_TRANSITIONS) and it carries a reason.
  submitted: ['verified', 'booked'],
  // Terminal. A verified card is a finished record of a test that was checked.
  verified:  [],
}

export function canTransition(from: TestCardStatus, to: TestCardStatus): boolean {
  return (TEST_CARD_TRANSITIONS[from] ?? []).includes(to)
}

/**
 * The two transitions that need `customer_review_requests.verify`.
 *
 * Named as a set rather than checked inline so the UI, the capability
 * derivation and the tests all read one list. Verifying and returning are both
 * a verifier's judgement about somebody else's evidence; everything before them
 * belongs to the tester holding the card.
 */
export const VERIFIER_ONLY_TRANSITIONS: ReadonlySet<TestCardStatus> =
  new Set<TestCardStatus>(['verified', 'booked'])

export function transitionRequiresVerify(to: TestCardStatus): boolean {
  return VERIFIER_ONLY_TRANSITIONS.has(to)
}

/** A card that can no longer move at all. */
export function isTerminalStatus(status: TestCardStatus): boolean {
  return (TEST_CARD_TRANSITIONS[status] ?? []).length === 0
}

// ─── Submission prerequisites ─────────────────────────────────────────────────

/**
 * What a booked card needs before it may be submitted for verification, as
 * sentences a tester can act on.
 *
 * Mirrors assert_customer_review_test_card_submittable() in the migration, one
 * check for one check, in the same order. An empty array means it is ready.
 *
 * TWO THINGS, AND THEY ARE DELIBERATELY DIFFERENT THINGS:
 *
 *   1. THE TESTER CONFIRMED THEY SENT IT. A separate, deliberate action, taken
 *      after they actually pressed send in WhatsApp. `whatsapp_opened_at` is
 *      NOT accepted in its place and never will be — opening a wa.me link hands
 *      the text to WhatsApp and proves nothing about what happened next.
 *
 *   2. A SCREENSHOT IS ATTACHED. Evidence that the WORKFLOW was exercised, and
 *      nothing more than that. It is not proof of a review — there is no review
 *      — and it is not proof of delivery either; it is the artefact a verifier
 *      looks at to decide whether this test was actually run.
 */
export function submissionBlockers(
  card: Pick<TestCard, 'sent_confirmed_at'>,
  screenshotCount: number,
): string[] {
  const blockers: string[] = []

  if (!card.sent_confirmed_at) {
    blockers.push('Confirm that you sent the internal test message.')
  }
  if (screenshotCount === 0) {
    blockers.push('Attach a screenshot of the internal test you sent.')
  }

  return blockers
}

// ─── What the screen offers ───────────────────────────────────────────────────

export type TestCardAction = {
  to: TestCardStatus
  /** The button's words. Plain operational language, not status names. */
  label: string
  /** Whether this action needs a short note before it can be taken. */
  prompt?: 'verification_note' | 'return_reason'
  /** Rendered as the cautionary option. */
  destructive?: boolean
}

const ACTION_LABELS: Record<TestCardStatus, TestCardAction> = {
  available: { to: 'available', label: 'Release' },
  // The wording carries the point: the tester is handing over what THEY did.
  submitted: { to: 'submitted', label: 'Submit for verification' },
  verified:  { to: 'verified',  label: 'Verify test', prompt: 'verification_note' },
  booked:    { to: 'booked',    label: 'Return to tester', prompt: 'return_reason', destructive: true },
}

/**
 * The moves this person may make on this card, in the order a screen should
 * offer them.
 *
 * Three separate gates, and all three have to pass:
 *   1. the transition table above,
 *   2. `verify` for the two verifier-only moves,
 *   3. HOLDING THE CARD (or being an admin) for everything else — a verifier
 *      does not run somebody else's test for them.
 *
 * This is the UI half of the boundary. The RPC re-checks all three, and the RPC
 * is what actually refuses.
 */
export function availableActions(
  card: Pick<TestCard, 'status' | 'booked_by'>,
  viewer: { userId: string | null; isAdmin: boolean; canUse: boolean; canVerify: boolean },
): TestCardAction[] {
  if (!viewer.userId) return []

  const holdsCard = card.booked_by === viewer.userId

  return (TEST_CARD_TRANSITIONS[card.status] ?? [])
    .filter(to => {
      if (transitionRequiresVerify(to)) return viewer.isAdmin || viewer.canVerify
      return viewer.isAdmin || (holdsCard && viewer.canUse)
    })
    .map(to => ACTION_LABELS[to])
}

/**
 * May this person book this card?
 *
 * The browser-side mirror of book_customer_review_test_card(). An admin is
 * included because every module here admits one — and because somebody has to
 * be able to exercise the workflow on a fresh deployment before any grant
 * exists.
 *
 * THE ATOMICITY IS NOT HERE. This function decides what button to draw. Whether
 * two testers clicking at once both get the card is decided by a conditional
 * UPDATE in the database, and by nothing in this file.
 */
export function canBookCard(
  card: Pick<TestCard, 'status'>,
  viewer: { userId: string | null; isAdmin: boolean; canUse: boolean },
): boolean {
  if (!viewer.userId) return false
  if (card.status !== 'available') return false
  return viewer.isAdmin || viewer.canUse
}
