// PATCH /api/customer-reviews/draft — a verifier corrects one draft's words.
//
// WHAT THIS IS FOR. A batch arrives, eleven drafts read well and one has a
// phrase the verifier would not put their name to. Before this route the
// choices were approve it as written, revise the whole batch against new
// guidance and lose the eleven good ones, or delete it. Correcting one sentence
// was not among them.
//
// ── WHAT IT IS NOT ─────────────────────────────────────────────────────────
//
// IT DOES NOT APPROVE ANYTHING. There is no status in the update, no call to
// approve_customer_review_drafts, and the draft is still `pending_approval`
// when this returns. Saving and approving are two deliberate actions, and this
// is the first one only.
//
// IT DOES NOT CALL A MODEL. No provider, no ANTHROPIC_API_KEY, no prompt. The
// text comes from the verifier's keyboard; regenerating from feedback is what
// /api/customer-reviews/revise is for, and it is a different thing.
//
// IT CANNOT TOUCH AN APPROVED REVIEW. Checked here for a clear answer, and
// decided by edit_customer_review_draft(), which locks the row and re-reads the
// status before it writes. Once a review is approved a candidate may have read
// it, booked it or sent it; text that changes underneath that is text nobody
// can vouch for afterwards.
//
// ── THE ORDER OF WORK ──────────────────────────────────────────────────────
//
//   1. authenticate the caller, as the CALLER;
//   2. resolve customer_review_requests.verify for them — BEFORE the body is
//      read, so a caller who may not edit learns nothing about what a valid
//      request looks like;
//   3. validate the text against the SAME rules a generated draft is held to;
//   4. hand it to the definer function, which resolves the permission a second
//      time, locks the row and decides.
//
// THE TEXT IS VALIDATED IN THREE PLACES and all three have to agree: this route
// (validateDraftText), the SQL function (the telephone check), and the column
// CHECKs on test_title and test_body (the lengths). None of them is decoration
// — a route is the easiest of the three to bypass.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { validateDraftText } from '@/lib/customerReviews/draftGeneration'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Every sentence this route can return, and it returns nothing else.
 *
 * An allow-list rather than a formatter, for the reason the sibling routes give:
 * a template is a thing that one day interpolates a value somebody forgot was
 * caller-influenced. The exception is the VALIDATION message, which comes from
 * validateDraftText and is written from constants, never from the input.
 */
const MESSAGES = {
  unauthenticated: 'Sign in to continue.',
  forbidden:       'You do not have permission to edit reviews.',
  not_found:       'That review is not available.',
  not_pending:     'This review has been approved, so its text can no longer be edited.',
  bad_request:     'That request could not be read.',
  unavailable:     'Review editing is not configured on this deployment.',
  save_failed:     'That change could not be saved. Try again.',
} as const

const fail = (status: number, error: string) =>
  NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store, private' } })

const ok = (body: Record<string, unknown>) =>
  NextResponse.json(body, { status: 200, headers: { 'Cache-Control': 'no-store, private' } })

export async function PATCH(req: Request) {
  // ── 1. Who is asking ──────────────────────────────────────────────────────
  const caller = await createClient()
  const { data: { user }, error: authError } = await caller.auth.getUser()
  if (authError || !user) return fail(401, MESSAGES.unauthenticated)

  // is_active only. The role column is deliberately not selected, as everywhere
  // else in this module: a value that never arrives cannot be branched on.
  const { data: profile } = await caller
    .from('users')
    .select('is_active')
    .eq('id', user.id)
    .single()
  if (!profile || profile.is_active !== true) return fail(403, MESSAGES.forbidden)

  // ── 2. The permission, RESOLVED, before the body is read ──────────────────
  const { data: allowed } = await caller.rpc('resolve_permission', {
    p_user_id:    user.id,
    p_module_key: 'customer_review_requests',
    p_action_key: 'verify',
  })
  if (allowed !== true) return fail(403, MESSAGES.forbidden)

  // ── 3. What they sent ─────────────────────────────────────────────────────
  let cardId: string
  let title: string
  let body: string
  try {
    const payload = await req.json() as
      { cardId?: unknown; title?: unknown; body?: unknown } | null

    if (typeof payload?.cardId !== 'string' || !UUID.test(payload.cardId)) {
      return fail(400, MESSAGES.bad_request)
    }
    cardId = payload.cardId

    const checked = validateDraftText(payload?.title, payload?.body)
    if (!checked.ok) return fail(400, checked.error)
    title = checked.title
    body = checked.body
  } catch {
    return fail(400, MESSAGES.bad_request)
  }

  // ── 4. May they edit THIS one ─────────────────────────────────────────────
  //
  // Read as the CALLER, so the card's own SELECT policy decides. A draft they
  // may not see returns no row, and this route cannot tell "not yours" from
  // "does not exist" — which is the answer they should get either way.
  //
  // The status is read here for a CLEAR ANSWER, not as the guarantee. The
  // definer function locks the row and reads it again, which is what makes a
  // draft approved between this read and that write refuse rather than slip
  // through.
  const { data: card } = await caller
    .from('customer_review_test_cards')
    .select('id, status, deleted_at')
    .eq('id', cardId)
    .maybeSingle()
  if (!card || card.deleted_at !== null) return fail(404, MESSAGES.not_found)
  if (card.status !== 'pending_approval') return fail(409, MESSAGES.not_pending)

  const admin = adminClient()
  if (!admin.ok) {
    // The NAMES of the missing variables, never their values.
    console.error('[customer-reviews:draft] missing env:', admin.missing.join(', '))
    return fail(503, MESSAGES.unavailable)
  }

  // ── 5. The write, where it is actually decided ────────────────────────────
  const { data: row, error } = await admin.client.rpc('edit_customer_review_draft', {
    p_card_id:  cardId,
    p_title:    title,
    p_body:     body,
    p_actor_id: user.id,
  })

  if (error) {
    // The database's own refusal codes, mapped to sentences chosen here. The
    // message text is never forwarded: it is written for a person, but it is
    // not this route's to choose, and it can name a reference the caller may
    // not be entitled to.
    const code = error.message ?? ''
    if (code.includes('CUSTOMER_REVIEW_TEST_NOT_PENDING')) return fail(409, MESSAGES.not_pending)
    if (code.includes('CUSTOMER_REVIEW_TEST_DELETED'))     return fail(404, MESSAGES.not_found)
    if (code.includes('CUSTOMER_REVIEW_TEST_NOT_FOUND'))   return fail(404, MESSAGES.not_found)
    if (code.includes('CUSTOMER_REVIEW_TEST_UNAUTHORIZED')) return fail(403, MESSAGES.forbidden)
    if (code.includes('CUSTOMER_REVIEW_TEST_BAD_DRAFT'))   return fail(400, MESSAGES.bad_request)
    console.error('[customer-reviews:draft] edit failed')
    return fail(500, MESSAGES.save_failed)
  }

  // The single-row table the function returns, normalised.
  const updated = (Array.isArray(row) ? row[0] : row) as {
    id: string
    test_title: string
    test_body: string
    status: string
    draft_edited_at: string | null
  } | null
  if (!updated) return fail(500, MESSAGES.save_failed)

  return ok({
    card: {
      id:              updated.id,
      test_title:      updated.test_title,
      test_body:       updated.test_body,
      status:          updated.status,
      draft_edited_at: updated.draft_edited_at,
    },
  })
}
