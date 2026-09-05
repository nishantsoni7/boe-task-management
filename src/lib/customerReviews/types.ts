// Review Workflow Test (Internal) — domain types, label maps and query column
// lists.
//
// The column constants live here, not inline in each page, for the reason
// src/lib/meetings/types.ts gives: the list screen and the detail screen read
// the same rows, and a column added to one query and not another is how a
// filter silently starts matching nothing.
//
// Mirrors supabase/migrations/20261017000000_customer_review_outreach.sql.
//
// WHAT THESE ROWS ARE. A `customer_review_test_cards` row is a TEST CARD: a
// piece of obviously fictional filler text, loaded from a fixture, that exists
// so somebody can walk the book → open WhatsApp → confirm → screenshot → verify
// path end to end. It is not a review, it is not attributed to a customer, and
// there is no field on it that could hold a customer's name, number or project.
// See src/lib/customerReviews/internalTest.ts.

// ─── Status ───────────────────────────────────────────────────────────────────

/**
 * Five states, and the fifth comes first.
 *
 *   pending_approval  a batch generated this draft and no verifier has released
 *                     it. A CANDIDATE CANNOT SEE IT AT ALL — not on a screen,
 *                     not through the API, not by typing its id. The SELECT
 *                     policy offers a card two ways in, the available pool or a
 *                     row you hold, and a pending draft is neither. Only
 *                     approve_customer_review_drafts moves it.
 *
 *   available   nobody has taken this card. Any authorized tester may book it.
 *   booked      one tester holds it. They open WhatsApp, confirm by hand that
 *               they sent the test message, and attach a screenshot.
 *   submitted   the tester has handed it to a verifier. It is out of their
 *               hands and into the verification queue.
 *   verified    a verifier checked the evidence. The card leaves every active
 *               list and stays in the verifier's history.
 *
 * THERE IS NO 'returned' STATUS, and that is a deliberate choice rather than an
 * omission. A verifier who finds the evidence unusable sends the card BACK TO
 * 'booked' — the tester holds it again, exactly as they did before submitting —
 * and the reason is recorded on the row (return_reason, returned_at,
 * returned_by) and in the append-only trail. That gives the verifier the return
 * action the workflow needs without adding a state, which is the smallest thing
 * that answers the requirement.
 *
 * ─── THE STATE MAP, IN FULL ─────────────────────────────────────────────────
 *
 * The module expresses sub-states as a status PLUS a column, and always has:
 * "sent" and "returned" are both status 'booked' with a timestamp set. Approval
 * follows the same idiom rather than inventing a second vocabulary, and nothing
 * is renamed.
 *
 *   conceptual state        status              discriminator
 *   ─────────────────────── ─────────────────── ───────────────────────────────
 *   pending approval        pending_approval    approved_at is null (enforced)
 *   approved and available  available           approved_at is not null
 *   booked but not sent     booked              sent_confirmed_at is null
 *   sent                    booked              sent_confirmed_at is not null
 *   submitted               submitted           —
 *   returned                booked              returned_at is not null
 *   verified                verified            —
 *
 * APPROVAL STATE AND CANDIDATE STATE ARE NOT THE SAME AXIS. approved_at records
 * a verifier's decision about the TEXT and is never cleared; status records
 * where the card is in a candidate's workflow and moves back and forth.
 * Releasing a booking returns a card to 'available' and leaves the approval
 * exactly where it was, because the approval was never about the booking.
 *
 * Mirrors the CHECK on customer_review_test_cards.status in
 * supabase/migrations/20261026000000.
 */
export const TEST_CARD_STATUSES = [
  'pending_approval',
  'available',
  'booked',
  'submitted',
  'verified',
] as const

export type TestCardStatus = (typeof TEST_CARD_STATUSES)[number]

/**
 * WHICH ACTION DELETED A REVIEW — the scope, recorded as a value.
 *
 * There is no free-text reason column beside this on purpose: a structured
 * source and a typed sentence would be two answers to one question, and the
 * sentence a person reads already lives on the append-only event row.
 *
 *   single       one review, deleted from its own row
 *   selected     part of a selection the verifier ticked
 *   all          the whole module, from Delete all reviews
 *   replacement  displaced by a newly approved batch, not chosen individually
 *
 * Mirrors customer_review_test_cards_deleted_source_check in
 * supabase/migrations/20261030000000.
 */
export const TEST_CARD_DELETION_SOURCES = [
  'single',
  'selected',
  'all',
  'replacement',
] as const

export type TestCardDeletionSource = (typeof TEST_CARD_DELETION_SOURCES)[number]

/**
 * What a deletion actually did, as the database counted it.
 *
 * RETURNED BY THE RPC, NOT COMPUTED BY THE BROWSER. The set is chosen and
 * locked inside the transaction, so these are the rows that were really
 * deleted rather than the rows a stale list thought would be — which is the
 * whole reason the functions return a shape instead of a bare integer.
 */
export type DeletionCounts = {
  deleted: number
  pending_approval: number
  available: number
  /** Booked, and the holder has NOT confirmed a send. */
  booked: number
  /** Booked, and the holder HAS confirmed a send. Counted apart because it is
   *  the stage a verifier most needs to see before pressing a delete. */
  sent: number
  submitted: number
  verified: number
}

/**
 * The live population, by stage, for the Delete all confirmation.
 *
 * Read from the database immediately before the confirmation is drawn, because
 * no tab on the list screen reads `verified` rows — a count assembled in the
 * browser would silently omit them, and "delete everything" must not be
 * confirmed against a number that leaves some of everything out.
 */
export type DeletionSummary = Omit<DeletionCounts, 'deleted'> & { total: number }

/**
 * What an approval did: how many drafts were released, and how many reviews
 * the release displaced.
 *
 * `replaced` is 0 for an Add, and for a Replace that found an empty pool.
 */
export type ApprovalResult = { approved: number; replaced: number }

/** The statuses a tester's "My booked tests" list shows. Verified is not one. */
export const ACTIVE_TESTER_STATUSES: ReadonlySet<TestCardStatus> =
  new Set<TestCardStatus>(['booked', 'submitted'])

// ─── Test category ────────────────────────────────────────────────────────────

/**
 * The ten scenario shapes the fixture covers.
 *
 * They exist to vary LAYOUT AND MESSAGE HANDLING — short lines, long lines,
 * with an image and without — not to describe anything that happened. Every one
 * is named `*_test` so that a category label can never be mistaken, on a screen
 * or in a WhatsApp message, for a claim about a real project.
 */
export const TEST_CATEGORIES = [
  'restaurant_test',
  'cafe_test',
  'hotel_test',
  'resort_test',
  'bulk_order_test',
  'customisation_test',
  'delivery_test',
  'product_quality_test',
  'service_test',
  'issue_resolution_test',
] as const

export type TestCategory = (typeof TEST_CATEGORIES)[number]

/**
 * The one kind of image this module stores.
 *
 * A screenshot a tester took of their own WhatsApp screen, as evidence that the
 * WORKFLOW was exercised. IT IS NOT EVIDENCE OF A REVIEW, and nothing in this
 * module treats it as such — there is no review to be evidence of.
 */
/**
 * TWO KINDS NOW, and they are genuinely different things sharing one table.
 *
 *   test_screenshot  a picture of BOE's own WhatsApp screen, attached by the
 *                    tester holding a booked card. Evidence that the workflow
 *                    was exercised. It goes nowhere.
 *   review_image     a picture of the furniture a review is about, attached by
 *                    a VERIFIER while the draft is still pending, kept after
 *                    approval, and offered to whoever shares the review.
 *
 * They share a table and a private bucket because the storage question — may
 * this person see this card — has one answer for both. They share nothing else:
 * different permission, different window, different route.
 */
export type TestPhotoKind = 'test_screenshot' | 'review_image'

// ─── Review type ──────────────────────────────────────────────────────────────

/**
 * TWO KINDS OF REVIEW, AND THE DIFFERENCE IS WHAT THE CANDIDATE POSTS.
 *
 *   text   the review's words, and nothing else.
 *   image  the words together with the photographs of ONE project, drawn from a
 *          project image group the verifier attached.
 *
 * IT IS A STORED FACT, NOT A DERIVATION. The reward depends on it, so it cannot
 * be inferred from whether images happen to be attached to something — a
 * derivation would be a price that changes when an unrelated row does.
 *
 * A generated batch is EXACTLY eight text and four image, and the DATABASE
 * counts them: create_customer_review_draft_batch() refuses any other
 * composition. See REVIEWS_PER_BATCH in ./reviewTypes.
 *
 * IT CANNOT BE CHANGED AFTER APPROVAL. set_customer_review_draft_type() refuses
 * anything but a pending draft, because by the time a review is approved and
 * assigned it has told a candidate what to do and told the ledger what to pay.
 *
 * Mirrors customer_review_test_cards_review_type_check in
 * supabase/migrations/20261107000000.
 */
export const REVIEW_TYPES = ['text', 'image'] as const

export type ReviewType = (typeof REVIEW_TYPES)[number]

export const REVIEW_TYPE_META: Record<ReviewType, BadgeMeta & { plural: string }> = {
  // Slate, so it reads as the ordinary case rather than as a warning.
  text:  { label: 'Text',  plural: 'Text reviews',  bg: '#F1F5F9', color: '#334155', border: '#E2E8F0' },
  // Teal, distinct from every status colour: an image review is not a state, and
  // the one thing a candidate must never misread is a type badge as a status.
  image: { label: 'Image', plural: 'Image reviews', bg: '#ECFEFF', color: '#155E75', border: '#A5F3FC' },
}

export function reviewTypeLabel(value: string | null | undefined): string {
  if (!value) return '—'
  return REVIEW_TYPE_META[value as ReviewType]?.label ?? value
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

export type TestCard = {
  id: string
  status: TestCardStatus

  /** Short human reference printed on the card and in the message. */
  card_ref: string
  test_category: TestCategory
  test_title: string
  /** The fictional filler. Fixture-supplied; no client can write it. */
  test_body: string

  /** Which generated batch this draft came from. Null for anything older. */
  batch_id: string | null

  /**
   * Text review or image review. THE FACT THE REWARD IS PRICED FROM.
   *
   * The database reads it off the locked row inside
   * transition_customer_review_test_card() and never from a parameter, so
   * nothing a browser sends can change which reward a verification posts.
   */
  review_type: ReviewType

  /**
   * The one employee this review belongs to, and the reason there is no longer
   * a company-wide pool.
   *
   * ASSIGNMENT IS NOT BOOKING. `assigned_to` is who may work on this review at
   * all; `booked_by` is who has actually picked it up. Releasing a booking
   * returns the review to its assignee rather than to everybody, because the
   * assignment was never about the booking — the same separation approval and
   * status already have.
   *
   * THE SELECT POLICY READS IT. An available review is visible to the person it
   * was assigned to and to a verifier, and to nobody else: not through the
   * page, not through PostgREST, not by typing an id.
   */
  assigned_to: string | null
  assigned_at: string | null
  assigned_by: string | null

  /**
   * The project image group an IMAGE review posts photographs from.
   *
   * Chosen once — when the batch is assigned, or later when a project becomes
   * ready — and then stable. A group that changed on every load would show a
   * candidate different photographs each time they opened the same review.
   *
   * NULL ON AN IMAGE REVIEW MEANS "WAITING FOR ADMIN IMAGES", which is a
   * readiness fact and deliberately NOT a sixth status. Always null on a text
   * review; a CHECK enforces it.
   */
  image_group_id: string | null

  /**
   * When a verifier released this draft into the candidate pool, and who did.
   *
   * Null exactly while the card is `pending_approval`, and never null again
   * once it is not — releasing a booking does not clear it. A generated card in
   * any state but pending carries an approver, and a CHECK enforces it.
   */
  approved_at: string | null
  approved_by: string | null
  /**
   * When a verifier last edited this draft's words by hand, and who did.
   *
   * BOTH OR NEITHER — a CHECK enforces it, because a timestamp with no actor is
   * an edit nobody is answerable for. Null on a draft that is still exactly
   * what the model produced.
   *
   * IT IS SHOWN, NOT MERELY STORED. A draft that has been edited is no longer
   * untouched AI text, and the screens say so rather than letting the
   * AI-generated label stand alone and imply otherwise.
   */
  draft_edited_at: string | null
  draft_edited_by: string | null

  booked_by: string | null
  booked_at: string | null

  /** Preparation, not delivery. See the module doc. */
  whatsapp_opened_at: string | null
  whatsapp_opened_count: number
  /**
   * WHO THE LAST LINK WENT TO — four digits, and nothing else.
   *
   * A tester may enter any valid international number, so the full value is
   * never stored. Four digits are what a person needs to recognise a number
   * they typed, and that is the whole of what is kept.
   */
  whatsapp_target_last_four: string | null

  /** The tester's separate, deliberate claim that they pressed send. */
  sent_confirmed_at: string | null
  sent_confirmed_by: string | null

  submitted_at: string | null
  submitted_by: string | null

  verified_at: string | null
  verified_by: string | null
  verification_note: string | null

  returned_at: string | null
  returned_by: string | null
  return_reason: string | null

  /**
   * THE TOMBSTONE. Non-null means a verifier deleted this review.
   *
   * IT IS NOT A STATUS, and that is deliberate. Deletion is orthogonal to how
   * far the review had got: `status` still reads 'booked' on one that was
   * deleted while somebody held it, which is what lets the trail answer "what
   * was thrown away, and from where". A deleted review leaves every
   * operational list, its direct URL stops resolving for a candidate, and
   * every workflow action refuses it.
   *
   * A CANDIDATE NEVER SEES ONE. Both candidate branches of the SELECT policy
   * require `deleted_at is null`; the third branch is verify-only and exists
   * so the tombstone stays readable to the people accountable for it.
   *
   * THERE IS NO RESTORE. A trigger refuses any UPDATE of a row whose
   * deleted_at is already set, so un-deleting is unexpressible rather than
   * merely unimplemented.
   */
  deleted_at: string | null
  deleted_by: string | null
  /** Which action deleted it — the scope, not a free-text reason. */
  deleted_source: TestCardDeletionSource | null
  /** The batch that displaced it. Set on a replacement and nowhere else. */
  replaced_by_batch_id: string | null

  created_at: string
  updated_at: string

  // Joined for display — never selected with `*`.
  tester_name?: string | null
  verifier_name?: string | null
  /** The assignee's display name, joined by the screens that list other people's work. */
  assignee_name?: string | null
}

// ─── The project image library ────────────────────────────────────────────────

/**
 * ONE GROUP IS ONE PROJECT.
 *
 * Its images are that project's photographs and nothing else, and that is the
 * whole mechanism by which two projects never end up in one candidate's post:
 * an image review points at a GROUP, not at four individually chosen images.
 * Selecting images one at a time is exactly the thing that would mix them.
 *
 * `label` is internal. It names the project for the people managing the
 * library; no candidate-facing screen shows it and no outgoing message carries
 * it.
 *
 * A GROUP IS ARCHIVED, NEVER DELETED. A review that points at one is a record
 * of what a candidate was asked to post, so the group has to keep existing.
 * Archiving takes it out of future random selection and touches nothing else.
 */
export type ReviewImageGroup = {
  id: string
  label: string
  created_by: string
  created_at: string
  updated_at: string
  archived_at: string | null
  archived_by: string | null

  // Joined for display — never selected with `*`.
  /** Live images in the group. A group with none is not offered to a review. */
  image_count?: number
  /** How many live reviews currently point at it. */
  assigned_count?: number
  creator_name?: string | null
}

export const REVIEW_IMAGE_GROUP_COLUMNS =
  'id, label, created_by, created_at, updated_at, archived_at, archived_by'

/** One image inside a project group. Metadata for an object in the private bucket. */
export type ReviewGroupImage = {
  id: string
  group_id: string
  storage_path: string
  file_name: string
  mime_type: string
  byte_size: number
  uploaded_by: string
  uploaded_at: string
  /** Non-null while a removal is in flight. Every read filters these out. */
  removal_started_at: string | null
}

export const REVIEW_GROUP_IMAGE_COLUMNS =
  'id, group_id, storage_path, file_name, mime_type, byte_size, uploaded_by, uploaded_at, removal_started_at'

export type TestCardPhoto = {
  id: string
  card_id: string
  kind: TestPhotoKind
  /**
   * Which of the four places a review image occupies, 0 to 3.
   *
   * Null for a test screenshot, which has no slot because there is only ever
   * one. For a review image it is what makes "at most four" a unique index over
   * (card_id, image_slot) rather than a count somebody has to remember to take
   * before every insert — see customer_review_image_one_live_per_slot.
   */
  image_slot: number | null
  storage_path: string
  file_name: string
  mime_type: string
  byte_size: number
  uploaded_by: string
  uploaded_at: string
  /** Non-null while a removal is in flight. Every read filters these out. */
  removal_started_at: string | null
}

export type TestCardEventType =
  /** A batch created this draft. Its first line, written at generation. */
  | 'generated'
  /** Its title and body were regenerated from new guidance, while pending. */
  | 'revised'
  /**
   * A verifier typed over this draft's title and body before approving it.
   *
   * Distinct from 'revised', which is a model rewriting a whole batch from new
   * guidance. This one is a person changing one review's words, and the two are
   * separate types because "who wrote this sentence" has different answers.
   */
  | 'draft_edited'
  /** A verifier released it into the candidate pool. */
  | 'approved'
  | 'booked'
  /** The holder released it before confirming a send. */
  | 'unbooked'
  | 'whatsapp_opened'
  | 'sent_confirmed'
  | 'submitted'
  | 'verified'
  | 'returned'
  /** An administrator withdrew an attached screenshot. Written by a trigger. */
  | 'screenshot_removed'
  /** A verifier withdrew an attached review image. Written by the same trigger. */
  | 'image_removed'
  /**
   * A verifier deleted this review. `previous_status` names where it was, and
   * that is the point of the row: it is the only record of what was thrown
   * away and how far somebody had got with it.
   */
  | 'deleted'
  /** A newly approved batch displaced this review out of the available pool. */
  | 'replaced'

export type TestCardEvent = {
  id: string
  card_id: string
  event_type: TestCardEventType
  previous_status: TestCardStatus | null
  new_status: TestCardStatus | null
  detail: string | null
  actor_id: string
  created_at: string
  actor_name?: string | null
}

// ─── Query columns ────────────────────────────────────────────────────────────
//
// Named explicitly, never `*`. `select('*')` against a table joined to
// public.users is a permission error in this project (see
// src/lib/users/safeColumns.ts), and naming columns is how a field stays out of
// a query somebody adds later without thinking about it.

export const TEST_CARD_COLUMNS = [
  'id',
  'status',
  'card_ref',
  'test_category',
  'test_title',
  'test_body',
  'batch_id',
  // THE THREE FACTS ADDED BY REVIEW TYPES, and every one of them is displayed:
  // the type decides which section a review sits in and what it pays, the
  // assignment decides whose it is, and the group decides whether it is ready.
  'review_type',
  'assigned_to',
  'assigned_at',
  'assigned_by',
  'image_group_id',
  'approved_at',
  'approved_by',
  'draft_edited_at',
  'draft_edited_by',
  'booked_by',
  'booked_at',
  'whatsapp_opened_at',
  'whatsapp_opened_count',
  'whatsapp_target_last_four',
  'sent_confirmed_at',
  'sent_confirmed_by',
  'submitted_at',
  'submitted_by',
  'verified_at',
  'verified_by',
  'verification_note',
  'returned_at',
  'returned_by',
  'return_reason',
  // THE TOMBSTONE TRAVELS WITH THE ROW. The screens filter deleted reviews out
  // in the query; selecting the columns anyway is what lets the detail page
  // tell a verifier they are looking at a deleted review rather than render it
  // silently as though it were live.
  'deleted_at',
  'deleted_by',
  'deleted_source',
  'replaced_by_batch_id',
  'created_at',
  'updated_at',
].join(', ')

/**
 * The AVAILABLE list's columns.
 *
 * Narrower than the detail set on purpose. An available card has no tester, no
 * timestamps and no evidence, so a list that selected those columns would be
 * selecting nulls — and it would be one edit away from selecting them for rows
 * that are not available. The preview is truncated for display in the component,
 * not here: truncating in SQL would make the full text unreachable to the
 * detail screen that legitimately needs it.
 */
export const TEST_CARD_AVAILABLE_COLUMNS = [
  'id',
  'status',
  'card_ref',
  'test_category',
  'test_title',
  'test_body',
  // THE THREE THAT DECIDE WHAT THIS LIST LOOKS LIKE. `review_type` splits it
  // into its two sections, `image_group_id` is the difference between Ready and
  // Waiting for admin images, and `assigned_to` is what the counts are of.
  'review_type',
  'assigned_to',
  'assigned_at',
  'image_group_id',
  // Selected so the list can ASSERT what its filter did, not to display it.
  'deleted_at',
  'created_at',
].join(', ')

/**
 * THE PENDING-APPROVAL LIST'S COLUMNS, for the verifier workspace.
 *
 * Narrower than the detail set for the same reason the available set is: a
 * pending draft has no holder, no evidence and no timestamps, so those columns
 * would be nulls. It carries `batch_id` and nothing the available set does not,
 * because approval is decided per batch.
 *
 * IT IS NOT A SECURITY BOUNDARY. RLS is what stops a candidate reading a
 * pending row at all; naming columns is what stops a field joining a query
 * somebody adds later without thinking about it.
 */
export const TEST_CARD_PENDING_COLUMNS = [
  'id',
  'status',
  'card_ref',
  'test_category',
  'test_title',
  'test_body',
  'batch_id',
  // THE TYPE IS DISPLAYED AND CORRECTABLE HERE, which is why it is selected
  // here: the pending workspace is the only window in which a verifier may
  // change it, and a badge that reads the wrong column would be a badge showing
  // a correction that did not happen.
  'review_type',
  'image_group_id',
  // THE EDIT STAMP IS DISPLAYED HERE, so it is selected here.
  //
  // It was missed when editing was added, and the consequence was quiet rather
  // than loud: the tile rendered, the draft was genuinely edited, and the
  // "Edited by a verifier" badge simply never appeared — because the column it
  // reads was not in the query. A verifier scanning twelve drafts had no way to
  // see which ones somebody had already been through.
  'draft_edited_at',
  'draft_edited_by',
  'deleted_at',
  'created_at',
].join(', ')

// ─── Generated batches ────────────────────────────────────────────────────────

/**
 * One generated batch: who asked, when, with what guidance, and which model.
 *
 * `expected_count` and `card_count` are always equal, and holding both is what
 * makes that checkable rather than merely asserted — the insert is one
 * transaction, so a batch that produced the wrong number of drafts produces no
 * row at all. A FAILED GENERATION HAS NO ROW HERE BY DESIGN; there is no
 * half-batch to mark failed, and the reason a batch failed is in the route's
 * server log, which is the only place a rolled-back transaction can record
 * anything.
 */
export type DraftBatch = {
  id: string
  generated_by: string
  generated_at: string
  guidance: string
  model: string
  card_count: number
  expected_count: number
}

export const DRAFT_BATCH_COLUMNS =
  'id, generated_by, generated_at, guidance, model, card_count, expected_count'

/** One append-only record of a batch's pending drafts being regenerated. */
export type DraftBatchRevision = {
  id: string
  batch_id: string
  revised_by: string
  revised_at: string
  guidance: string
  model: string
  revised_count: number
}

export const DRAFT_BATCH_REVISION_COLUMNS =
  'id, batch_id, revised_by, revised_at, guidance, model, revised_count'

export const TEST_CARD_PHOTO_COLUMNS =
  'id, card_id, kind, image_slot, storage_path, file_name, mime_type, byte_size, uploaded_by, uploaded_at, removal_started_at'

export const TEST_CARD_EVENT_COLUMNS =
  'id, card_id, event_type, previous_status, new_status, detail, actor_id, created_at'

// ─── Display ──────────────────────────────────────────────────────────────────

export type BadgeMeta = { label: string; bg: string; color: string; border: string }

/**
 * One colour per status, reused by the row badge, the tab strip and the detail
 * header — the convention MEETING_STATUS_META established.
 *
 * `submitted` is neutral blue rather than green ON PURPOSE. Green reads as
 * "done", and a submitted card has achieved nothing yet: nobody has looked at
 * the evidence. Only `verified` — the state a person actually checked — is
 * green.
 */
export const TEST_CARD_STATUS_META: Record<TestCardStatus, BadgeMeta> = {
  // Violet, matching the AI-generated-draft note: both say "this text has not
  // been through a person yet". It is deliberately NOT grey like Available —
  // the one distinction a verifier must never misread on a crowded screen is
  // "waiting for me" against "already released".
  pending_approval: { label: 'Pending approval', bg: '#F5F3FF', color: '#5B21B6', border: '#DDD6FE' },
  available: { label: 'Available', bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' },
  booked:    { label: 'Booked',    bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  submitted: { label: 'Submitted', bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' },
  verified:  { label: 'Verified',  bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
}

export const TEST_CATEGORY_META: Record<TestCategory, { label: string }> = {
  restaurant_test:       { label: 'Restaurant' },
  cafe_test:             { label: 'Café' },
  hotel_test:            { label: 'Hotel' },
  resort_test:           { label: 'Resort' },
  bulk_order_test:       { label: 'Bulk order' },
  customisation_test:    { label: 'Customisation' },
  delivery_test:         { label: 'Delivery' },
  product_quality_test:  { label: 'Product quality' },
  service_test:          { label: 'Service' },
  issue_resolution_test: { label: 'Issue resolution' },
}

export function testCategoryLabel(value: string | null | undefined): string {
  if (!value) return '—'
  return TEST_CATEGORY_META[value as TestCategory]?.label ?? value
}

/** dd MMM yyyy, matching formatMeetingDate. Empty input reads as an em dash. */
export function formatTestDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** dd MMM yyyy, HH:mm — used where the ORDER of two events matters. */
export function formatTestTimestamp(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}
