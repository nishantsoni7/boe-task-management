// Review types: the composition of a batch, whether an image review is ready,
// and the operational counts both audiences read.
//
// PURE. No client, no DOM, no environment. Everything here is a function of
// rows the caller already has, which is what lets the counts a candidate sees
// and the counts an admin sees be THE SAME FUNCTION rather than two queries
// that agree by coincidence.
//
// ── WHAT THIS FILE IS NOT ──────────────────────────────────────────────────
//
// It is not a permission check and it is not a guarantee. `canUseImageReview()`
// decides whether to draw a control; book_customer_review_test_card() decides
// whether a review is booked, and it re-asks every question below inside the
// conditional UPDATE that claims the row. A screen and a database that disagree
// here produce a disabled button and a refusal, never a wrong booking.

import { MAX_BATCH_SIZE, MIN_BATCH_SIZE } from './generationSettings'
import type { ReviewType, TestCard } from './types'

// ─── The composition of a batch ───────────────────────────────────────────────

/**
 * ONE IMAGE REVIEW IN THREE, WHATEVER THE BATCH SIZE.
 *
 * It used to be the pair of constants 8 and 4, which was the same ratio written
 * down for the one batch size that existed. A batch is now anything from six to
 * twenty reviews, and a pair of constants cannot describe a batch of seven —
 * so the ratio is what is stored and the two counts are derived from it.
 *
 * TWELVE STILL GIVES EXACTLY EIGHT AND FOUR. That is the point of choosing a
 * third rather than a nicer-looking number: nothing about a batch generated
 * before this change, or a batch of twelve generated after it, moves.
 *
 * THE SPLIT IS NOT THE MODEL'S CHOICE, and that is the requirement rather than
 * an implementation preference. The model is asked to write N reviews; the
 * types are assigned by assignReviewTypes() before the batch is sent to SQL,
 * and create_customer_review_draft_batch() derives the same two numbers from
 * the batch size and refuses any other composition. A model that decided to
 * produce eleven text reviews would change nothing: they are typed here
 * regardless.
 *
 * THE ROUNDING HAS TO MATCH THE DATABASE'S, and it does: `round(n / 3)` in both
 * places, and no batch size between six and twenty divides by three to a
 * halfway value, so there is no tie for the two languages to break differently.
 */
export const IMAGE_REVIEW_DIVISOR = 3

export function imageReviewsFor(batchSize: number): number {
  const size = Math.max(0, Math.trunc(batchSize))
  return Math.min(size, Math.round(size / IMAGE_REVIEW_DIVISOR))
}

export function textReviewsFor(batchSize: number): number {
  const size = Math.max(0, Math.trunc(batchSize))
  return size - imageReviewsFor(size)
}

/**
 * The type of the draft at each position in a batch, as a list.
 *
 * TEXT FIRST, THEN IMAGE, and the order is deliberate rather than arbitrary: a
 * verifier reading a batch reads the ones of one kind together and then the
 * others, instead of switching context on every card. Nothing downstream
 * depends on the order — the database counts, it does not check positions — so
 * this is a readability decision and is free to change.
 */
export function reviewTypeSequence(batchSize: number): ReviewType[] {
  const size = Math.max(0, Math.trunc(batchSize))
  return [
    ...Array<ReviewType>(textReviewsFor(size)).fill('text'),
    ...Array<ReviewType>(imageReviewsFor(size)).fill('image'),
  ]
}

/**
 * Stamp the batch composition onto whatever the model returned.
 *
 * IT IGNORES ANY TYPE THE MODEL SUPPLIED. There is no branch that reads one, no
 * fallback that trusts one, and no way for a reply to influence the mix. The
 * count is a business rule about what an employee is asked to do and what they
 * are paid; it is not a thing to negotiate with a language model.
 *
 * THE SIZE COMES FROM THE LIST, NOT FROM A PARAMETER, so this cannot be handed
 * a length and a different set of drafts and quietly type the wrong number of
 * them. A list outside the legal batch range is refused rather than typed: the
 * caller has already validated the length against what it asked the model for
 * by the time it gets here, so a list of the wrong size means something further
 * up went wrong and inventing a composition for it would hide that.
 */
export function assignReviewTypes<T>(drafts: readonly T[]): (T & { type: ReviewType })[] {
  if (drafts.length < MIN_BATCH_SIZE || drafts.length > MAX_BATCH_SIZE) {
    throw new Error(
      `a batch is ${MIN_BATCH_SIZE} to ${MAX_BATCH_SIZE} reviews; ${drafts.length} were supplied`,
    )
  }
  const sequence = reviewTypeSequence(drafts.length)
  return drafts.map((draft, i) => ({ ...draft, type: sequence[i] }))
}

/** How many of each type a set of drafts holds. Used by the tests and the UI. */
export function countByType(
  rows: readonly { review_type: ReviewType }[],
): { text: number; image: number } {
  let text = 0
  let image = 0
  for (const row of rows) {
    if (row.review_type === 'image') image++
    else text++
  }
  return { text, image }
}

// ─── Readiness ────────────────────────────────────────────────────────────────

/**
 * Whether an IMAGE review has its project photographs yet.
 *
 *   ready              it has a group, and the group has images
 *   awaiting_images    it has no group, or the group it has is empty
 *   not_applicable     it is a text review, which needs no project at all
 *
 * READINESS IS NOT A STATUS, and this function is the whole reason it does not
 * need to be. A review waiting for its images is `available` like any other; it
 * simply cannot be booked. Adding a sixth status would have put an image
 * review's workflow position and its preparation on one axis, and they are two
 * different things that move at different times — the same mistake the module
 * has already declined to make for "sent" and "returned".
 *
 * `groupUsable` IS THE WHOLE OF THE SECOND CONDITION, and it is passed in
 * rather than read here because it lives in two other tables:
 *
 *   the group is NOT ARCHIVED  — customer_review_image_groups.archived_at
 *   and holds a LIVE IMAGE     — customer_review_group_images, removal_started_at
 *
 * An archived project is one nobody is posting about any more, so a review
 * still pointing at it is not ready even though it names a group. The database
 * asks exactly the same two questions inside the UPDATE that books the review —
 * see book_customer_review_test_card() in 20261107000000 — so a screen and a
 * database that disagree here produce a disabled control and a refusal, never a
 * booking that should not have happened.
 *
 * Callers that have not read it pass `undefined`, which means "unknown, so
 * assume the group is usable". That is the right default for a LIST, which
 * cannot afford a query per row: the database refuses the booking either way,
 * and greying out a control on a guess would be worse than letting the refusal
 * say why. Every caller that can actually act on one review — the detail
 * screen, the share control — reads the fact and passes it.
 */
export type ImageReadiness = 'ready' | 'awaiting_images' | 'not_applicable'

export function imageReadiness(
  card: Pick<TestCard, 'review_type' | 'image_group_id'>,
  groupUsable?: boolean,
): ImageReadiness {
  if (card.review_type !== 'image') return 'not_applicable'
  if (!card.image_group_id) return 'awaiting_images'
  if (groupUsable === false) return 'awaiting_images'
  return 'ready'
}

/**
 * WHAT A LOADED PROJECT GROUP SAYS ABOUT READINESS, for a surface that loads
 * one. Text reviews and callers that load nothing get `undefined`, which is
 * what imageReadiness() and canBookCard() already treat as "no extra
 * information" — so this changes nothing for anybody who does not use it.
 *
 * `undefined` also means NOT YET ANSWERED while the read is in flight, and
 * callers treat that as "not bookable yet": an enabled Book that a resolved
 * read is about to withdraw is worse than a button that arrives a beat late.
 *
 * A READ THAT FAILED RESOLVES TO `false`, and deliberately. The panel of
 * photographs shows the waiting state for a set it could not load, and a badge
 * saying `Ready` beside a panel saying `Waiting for admin images` is the exact
 * contradiction this exists to remove. It fails closed and costs a reopened
 * sheet; the row is untouched, and the booking UPDATE still decides.
 */
export function projectGroupUsable(
  card: Pick<TestCard, 'review_type'>,
  /** Structurally typed, so this file does not depend on a component. */
  set: { usable: boolean | undefined; loading: boolean } | undefined,
): boolean | undefined {
  if (card.review_type !== 'image' || !set) return undefined
  if (set.loading) return undefined
  return set.usable === true
}

/** The sentence a candidate reads beside an image review that is not ready. */
export const AWAITING_IMAGES_LABEL = 'Waiting for admin images'
export const READY_LABEL = 'Ready'
/**
 * WHAT A SURFACE SAYS WHILE THE PROJECT GROUP IS STILL BEING READ.
 *
 * Not a third kind of readiness — imageReadiness() still answers with two —
 * but a third thing a BADGE can say, because for a moment the honest answer
 * is neither. Saying `Ready` and correcting it to `Waiting` a beat later is
 * the flicker this exists to prevent; saying `Waiting` first accuses an
 * administrator of not having done something they have in fact done.
 */
export const CHECKING_IMAGES_LABEL = 'Checking images'

export function readinessLabel(readiness: ImageReadiness): string | null {
  if (readiness === 'ready') return READY_LABEL
  if (readiness === 'awaiting_images') return AWAITING_IMAGES_LABEL
  return null
}

// ─── Operational counts ───────────────────────────────────────────────────────

/**
 * WHAT "POSTED" MEANS, and it is the one definition in this file worth arguing
 * about.
 *
 * Posted = the candidate has SUBMITTED the review with their evidence. Not
 * "verified" — verification is somebody else's judgement and has not happened
 * yet — and not "booked", which is only a claim on the work. A submitted review
 * is one where the person did the thing and handed over the screenshot, which
 * is the closest persisted fact to "they posted it" that this module actually
 * has, and the module is careful never to claim more than it knows.
 *
 * A VERIFIED REVIEW IS ALSO POSTED. It was submitted first — the transition
 * table admits no other route to `verified` — so counting it as posted is not a
 * choice, it is what the status means. `verified` is counted separately as
 * well, because management needs both numbers and they answer different
 * questions.
 *
 * REMAINING is what is left to do: assigned, minus posted. A booked review is
 * remaining, because the work has not been done yet — holding something is not
 * finishing it.
 */
export type ReviewCounts = {
  assigned: number
  /** Submitted or verified: the candidate has handed the work over. */
  posted: number
  /** A verifier has checked it. A subset of `posted`. */
  verified: number
  /** Booked and not yet submitted — in hand, not finished. */
  in_progress: number
  /** Assigned and not yet booked. What a candidate can pick up now. */
  available: number
  /** assigned − posted. What is still to do. */
  remaining: number
}

const EMPTY_COUNTS: ReviewCounts = {
  assigned: 0, posted: 0, verified: 0, in_progress: 0, available: 0, remaining: 0,
}

type CountableCard = Pick<TestCard, 'status' | 'deleted_at'>

/**
 * The counts for a set of reviews.
 *
 * A DELETED REVIEW COUNTS FOR NOTHING. It left the workflow; counting it under
 * "assigned" would tell a candidate they owe work that no longer exists.
 */
export function countReviews(cards: readonly CountableCard[]): ReviewCounts {
  const out: ReviewCounts = { ...EMPTY_COUNTS }
  for (const card of cards) {
    if (card.deleted_at) continue
    out.assigned++
    if (card.status === 'verified') { out.posted++; out.verified++ }
    else if (card.status === 'submitted') out.posted++
    else if (card.status === 'booked') out.in_progress++
    else if (card.status === 'available') out.available++
  }
  out.remaining = out.assigned - out.posted
  return out
}

/** The same counts, split by review type — what the candidate's two sections show. */
export type CountsByType = { text: ReviewCounts; image: ReviewCounts; all: ReviewCounts }

export function countReviewsByType(
  cards: readonly (CountableCard & Pick<TestCard, 'review_type'>)[],
): CountsByType {
  return {
    text:  countReviews(cards.filter(c => c.review_type !== 'image')),
    image: countReviews(cards.filter(c => c.review_type === 'image')),
    all:   countReviews(cards),
  }
}

/** "3 of 8 posted" — the per-type progress line, in one place so it reads alike everywhere. */
export function progressLine(counts: ReviewCounts): string {
  return `${counts.posted} of ${counts.assigned} posted`
}
