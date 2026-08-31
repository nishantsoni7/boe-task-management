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
 * Four states, and no fifth.
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
 * that answers the requirement. The four statuses above are the four the
 * product asked for and no more.
 */
export const TEST_CARD_STATUSES = [
  'available',
  'booked',
  'submitted',
  'verified',
] as const

export type TestCardStatus = (typeof TEST_CARD_STATUSES)[number]

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
export type TestPhotoKind = 'test_screenshot'

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

  created_at: string
  updated_at: string

  // Joined for display — never selected with `*`.
  tester_name?: string | null
  verifier_name?: string | null
}

export type TestCardPhoto = {
  id: string
  card_id: string
  kind: TestPhotoKind
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
  | 'booked'
  | 'whatsapp_opened'
  | 'sent_confirmed'
  | 'submitted'
  | 'verified'
  | 'returned'
  /** An administrator withdrew an attached screenshot. Written by a trigger. */
  | 'screenshot_removed'

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
  'created_at',
].join(', ')

export const TEST_CARD_PHOTO_COLUMNS =
  'id, card_id, kind, storage_path, file_name, mime_type, byte_size, uploaded_by, uploaded_at, removal_started_at'

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
