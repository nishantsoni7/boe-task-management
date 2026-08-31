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
  // APPROVAL IS NOT IN THIS TABLE EITHER, and for the same reason booking is
  // not: it moves a card through its own RPC, which locks every selected row
  // and rechecks it before writing. transition_customer_review_test_card()
  // reads one row, then locks it, then decides — one lock too late for a move
  // that must be atomic across a set. Listing pending_approval -> available
  // here would invite a future caller to route it through the generic function
  // and quietly lose the atomicity.
  pending_approval: [],
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
    blockers.push('Confirm that you sent the message.')
  }
  if (screenshotCount === 0) {
    blockers.push('Attach a screenshot of the message you sent.')
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
  // Neither of these is ever offered — no status in the table above lists them
  // as a destination — and they are here because the record is exhaustive over
  // TestCardStatus, which is how a new status added later shows up as a
  // compile error rather than as a missing button.
  pending_approval: { to: 'pending_approval', label: 'Return to drafting' },
  available: { to: 'available', label: 'Release' },
  // The wording carries the point: the tester is handing over what THEY did.
  submitted: { to: 'submitted', label: 'Submit for verification' },
  verified:  { to: 'verified',  label: 'Verify review', prompt: 'verification_note' },
  booked:    { to: 'booked',    label: 'Return to candidate', prompt: 'return_reason', destructive: true },
}

/**
 * The moves this person may make on this card, in the order a screen should
 * offer them.
 *
 * Three separate gates, and all three have to pass:
 *   1. the transition table above,
 *   2. `verify` for the two verifier-only moves,
 *   3. HOLDING THE CARD for everything else.
 *
 * GATE 3 HAS NO ADMINISTRATOR EXCEPTION. A tester action belongs to the tester
 * who booked the card — an administrator who did not run the test cannot submit
 * it as though they had, and neither can a verifier. Administrator and verifier
 * authority covers verifying and returning, which is gate 2.
 *
 * This is the UI half of the boundary. The RPC re-checks all three, and the RPC
 * is what actually refuses.
 */
export function availableActions(
  card: Pick<TestCard, 'status' | 'booked_by'>,
  viewer: { userId: string | null; canUse: boolean; canVerify: boolean },
): TestCardAction[] {
  if (!viewer.userId) return []

  const holdsCard = card.booked_by === viewer.userId

  return (TEST_CARD_TRANSITIONS[card.status] ?? [])
    .filter(to => {
      if (transitionRequiresVerify(to)) return viewer.canVerify
      return holdsCard && viewer.canUse
    })
    .map(to => ACTION_LABELS[to])
}

/**
 * May this person book this card?
 *
 * The browser-side mirror of book_customer_review_test_card(). `use` and
 * nothing else — an administrator books a card by holding `use`, which the
 * role_permissions seed grants them, rather than by being an administrator.
 * That is what makes an explicit revocation in Control Center actually revoke.
 *
 * THE ATOMICITY IS NOT HERE. This function decides what button to draw. Whether
 * two testers clicking at once both get the card is decided by a conditional
 * UPDATE in the database, and by nothing in this file.
 */
export function canBookCard(
  card: Pick<TestCard, 'status'>,
  viewer: { userId: string | null; canUse: boolean },
): boolean {
  if (!viewer.userId) return false
  // A PENDING DRAFT IS NOT BOOKABLE, and `status !== 'available'` already says
  // so — pending is a different status, so no extra clause is needed and none
  // was added. A candidate cannot see a pending row at all; this is the case
  // where a verifier is looking at one.
  if (card.status !== 'available') return false
  return viewer.canUse
}

/**
 * May this person release the booking they are holding?
 *
 * THE BROWSER-SIDE MIRROR OF unbook_customer_review_test_card(), one clause per
 * clause, and it decides what button to draw and nothing else. The database
 * re-checks every line of it under a row lock and is what actually refuses.
 *
 * FOUR CONDITIONS, and the third is the one the whole action turns on:
 *
 *   1. THE HOLDER, and nobody else. Not a colleague, not a verifier, not an
 *      administrator. A verifier's authority over somebody else's card is the
 *      RETURN path, which needs a reason and leaves the card with its holder.
 *   2. `use`, because releasing a booking is a candidate action like taking one.
 *   3. NOT YET CONFIRMED SENT. Once a person has stated that a message left
 *      their phone, that claim exists and cannot be withdrawn — and releasing
 *      the review would let somebody else book one that has already reached a
 *      real recipient.
 *   4. Still `booked`. A submitted card is out of the holder's hands.
 *
 * `hasLiveScreenshot` is a fifth condition the DATABASE also enforces, and it
 * is passed in rather than read from the card because it lives in another
 * table. Releasing a card with somebody's WhatsApp screen still attached would
 * show that image to every `use` holder, because an available card's
 * screenshots are readable by the whole pool.
 */
export function canUnbookCard(
  card: Pick<TestCard, 'status' | 'booked_by' | 'sent_confirmed_at'>,
  viewer: { userId: string | null; canUse: boolean },
  hasLiveScreenshot: boolean = false,
): boolean {
  // A RETURNED REVIEW IS NOT AN ORDINARY BOOKING, and it is refused by the
  // send-confirmation clause below rather than by a rule of its own — because
  // it CANNOT reach the returned state without one. Submitting requires
  // sent_confirmed_at (assert_customer_review_test_card_submittable), a return
  // is submitted -> booked, and sent_confirmed_at is never cleared while a card
  // is held. So `returned` always implies `sent`, and a review that has been
  // sent to a real recipient must never go back into the pool for somebody else
  // to send again. unbookBlocker() names the returned case separately, because
  // "you confirmed you sent it" is true but is not what the holder is looking at.
  if (!viewer.userId) return false
  if (!viewer.canUse) return false
  if (card.booked_by !== viewer.userId) return false
  if (card.status !== 'booked') return false
  if (card.sent_confirmed_at) return false
  if (hasLiveScreenshot) return false
  return true
}

/**
 * Why the Release control is not offered, as a sentence the holder can act on.
 *
 * Returns null when it IS offered. Separate from canUnbookCard() because a
 * disabled control that does not say why is a control people click twice: the
 * two answers a holder actually gets are "you already said you sent it" and
 * "take the screenshot off first", and both are things they can understand.
 */
export function unbookBlocker(
  card: Pick<TestCard, 'status' | 'booked_by' | 'sent_confirmed_at' | 'returned_at'>,
  viewer: { userId: string | null; canUse: boolean },
  hasLiveScreenshot: boolean = false,
): string | null {
  if (!viewer.userId || !viewer.canUse) return null
  if (card.booked_by !== viewer.userId || card.status !== 'booked') return null

  // THE RETURNED CASE IS NAMED FIRST, and it is a wording distinction rather
  // than a behavioural one. A returned review is refused for the same reason as
  // any sent one — it reached a real recipient — but a holder looking at a card
  // a verifier just handed back is not thinking about the send they made
  // yesterday. Telling them "you confirmed you sent it" is true and unhelpful;
  // telling them the card is theirs to finish is what they can act on.
  if (card.returned_at && card.sent_confirmed_at) {
    return 'A verifier sent this review back to you to finish, so it cannot be unbooked. Attach the evidence and submit it again.'
  }
  if (card.sent_confirmed_at) {
    return 'You confirmed you sent this review, so it can no longer be unbooked.'
  }
  if (hasLiveScreenshot) {
    return 'Remove the screenshot you attached before unbooking this review.'
  }
  return null
}

/**
 * May this person approve pending drafts?
 *
 * `verify`, resolved, and nothing else — the browser-side mirror of
 * approve_customer_review_drafts(). There is no administrator branch here for
 * the same reason there is none in the function: an administrator whose
 * `verify` was revoked in Control Center would otherwise be drawn a button the
 * database answers 42501.
 */
export function canApproveDrafts(viewer: { userId: string | null; canVerify: boolean }): boolean {
  return !!viewer.userId && viewer.canVerify
}
