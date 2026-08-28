import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { findAllowedNumber, readInternalTestAllowlist } from '@/lib/customerReviews/allowlist'
import { buildInternalTestMessage, buildWaMeUrl, hasInternalTestWarning } from '@/lib/customerReviews/internalTest'
import { testCategoryLabel } from '@/lib/customerReviews/types'

// THE ONLY PLACE A wa.me LINK IS BUILT.
//
// GET  returns the deployment's approved internal team numbers, to a caller who
//      may use the module.
// POST validates a chosen number against that same list, builds the message and
//      the link SERVER-SIDE, and — only when asked to — records that a link was
//      opened.
//
// WHY THE SERVER BUILDS THE LINK
// ------------------------------
// Because the allowlist is the point. If the browser assembled the URL, the
// allowlist would be a suggestion: a tester (or anything running in their tab)
// could put any number in the path, and the application would have produced a
// WhatsApp link to a stranger. Building it here means the number in the link is
// one the server chose from its own list, and the message text is one the
// server composed.
//
// WHAT THIS ROUTE DOES NOT DO, AND CANNOT
// ---------------------------------------
//   * IT DOES NOT SEND ANYTHING. There is no WhatsApp Business API client in
//     this repository, no token, no outbound HTTP call of any kind in this
//     file. The response body is a string.
//   * IT DOES NOT MARK A CARD AS SENT. `record: true` writes
//     whatsapp_opened_at, a counter and the target — and touches no status. The
//     tester's claim that they pressed send is a different call
//     (confirm_customer_review_test_card_sent), made by a person, afterwards.
//   * IT DOES NOT OPEN WHATSAPP. It returns a URL. Whether anything navigates
//     to it is the browser's business, and no test in this module does.
//
// FAIL CLOSED. A missing or malformed allowlist is a 503, not an empty list and
// not a permissive default. A number that is not on the list is a 403. Neither
// answer contains a number.

export const runtime = 'nodejs'

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Every sentence this route can return, and it returns nothing else.
 *
 * An allow-list rather than a formatter: the alternative is a template that one
 * day interpolates a value somebody forgot was caller-influenced. In this route
 * that value would be a phone number.
 */
const MESSAGES = {
  unauthenticated:  'Sign in to continue.',
  forbidden:        'You do not have permission to run internal tests.',
  not_found:        'That test card is not available.',
  wrong_status:     'You can only open WhatsApp for a card you currently hold.',
  bad_request:      'That request could not be processed.',
  not_allowlisted:  'That number is not an approved BOE internal test number.',
  allowlist_absent: 'Internal test numbers are not configured on this deployment.',
  unavailable:      'Internal testing is not configured on this deployment.',
  build_failed:     'The test message could not be prepared. Try again.',
  record_failed:    'That could not be recorded. Try again.',
} as const

const fail = (status: number, message: string) =>
  NextResponse.json({ error: message }, {
    status,
    // Private data, and a per-caller answer. Nothing about this response may be
    // cached by a proxy or a browser.
    headers: { 'Cache-Control': 'no-store, private' },
  })

const ok = (body: Record<string, unknown>) =>
  NextResponse.json(body, { status: 200, headers: { 'Cache-Control': 'no-store, private' } })

type Caller = {
  userId: string
  isAdmin: boolean
}

/**
 * Who is calling, and may they use this module.
 *
 * The cookie-scoped client, so this is the signed-in browser session and not a
 * token somebody put in a header. Returns the caller or the response to send
 * instead — never a partially-authorized state a later branch could misread.
 */
async function authorize(): Promise<{ caller: Caller } | { response: NextResponse }> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return { response: fail(401, MESSAGES.unauthenticated) }

  const { data: profile } = await supabase
    .from('users')
    .select('role, is_active')
    .eq('id', user.id)
    .single()
  // A failed profile read denies. An unidentified caller holding a stale
  // permission row is exactly the case that must not be admitted.
  if (!profile || profile.is_active !== true) return { response: fail(403, MESSAGES.forbidden) }

  const isAdmin = profile.role === 'admin'
  if (!isAdmin) {
    const { data: allowed } = await supabase.rpc('resolve_permission', {
      p_user_id: user.id,
      p_module_key: 'customer_review_requests',
      p_action_key: 'use',
    })
    if (allowed !== true) return { response: fail(403, MESSAGES.forbidden) }
  }

  return { caller: { userId: user.id, isAdmin } }
}

/**
 * The approved internal team numbers.
 *
 * ONLY the label and the E.164 form, and only to somebody who already holds
 * `use`. A colleague's mobile number is personal data; it is not exposed to an
 * unauthorized caller, to an anonymous one, or in any page that renders before
 * the guard has run.
 */
export async function GET() {
  const auth = await authorize()
  if ('response' in auth) return auth.response

  const allowlist = readInternalTestAllowlist()
  if (!allowlist.ok) {
    // The REASON, never the value. The detail names the variable and, at worst,
    // the POSITION of a bad entry — see parseInternalTestAllowlist.
    console.error('[customer-reviews:whatsapp] allowlist unusable:', allowlist.detail)
    return fail(503, MESSAGES.allowlist_absent)
  }

  return ok({
    numbers: allowlist.numbers.map(n => ({ label: n.label, e164: n.e164 })),
  })
}

/**
 * Build the link for one card and one approved number.
 *
 * Body: { cardId, number, record?: boolean }
 *
 * `record` defaults to FALSE, and the default is the safe one: previewing the
 * message a tester is about to send must not write anything. The screen asks
 * for record:true only on the control that actually opens WhatsApp.
 */
export async function POST(req: NextRequest) {
  const auth = await authorize()
  if ('response' in auth) return auth.response
  const { caller } = auth

  // ── What was sent ─────────────────────────────────────────────────────────
  let cardId: string
  let candidateNumber: string
  let record: boolean
  try {
    const body = await req.json()
    if (typeof body !== 'object' || body === null) return fail(400, MESSAGES.bad_request)

    const rawId = (body as Record<string, unknown>).cardId
    if (typeof rawId !== 'string' || !UUID_RE.test(rawId)) return fail(400, MESSAGES.bad_request)
    cardId = rawId

    const rawNumber = (body as Record<string, unknown>).number
    if (typeof rawNumber !== 'string' || rawNumber.length > 40) return fail(400, MESSAGES.bad_request)
    candidateNumber = rawNumber

    record = (body as Record<string, unknown>).record === true
  } catch {
    return fail(400, MESSAGES.bad_request)
  }

  // ── THE ALLOWLIST, BEFORE ANYTHING ELSE IS DONE WITH THE NUMBER ───────────
  //
  // Read first and checked first, so there is no branch in which a link is
  // built and then discarded — a link that exists in a variable is a link that
  // a later edit could return.
  const allowlist = readInternalTestAllowlist()
  if (!allowlist.ok) {
    console.error('[customer-reviews:whatsapp] allowlist unusable:', allowlist.detail)
    return fail(503, MESSAGES.allowlist_absent)
  }

  const target = findAllowedNumber(candidateNumber, allowlist.numbers)
  if (!target) return fail(403, MESSAGES.not_allowlisted)

  // ── May they act on THIS card ─────────────────────────────────────────────
  //
  // Read as the caller. can_view_customer_review_test_card_row() decides, so a
  // card belonging to somebody else returns no row and this route cannot tell
  // the difference between "not yours" and "does not exist" — which is the
  // answer the tester should get too.
  const supabase = await createClient()
  const { data: card } = await supabase
    .from('customer_review_test_cards')
    .select('id, status, booked_by, card_ref, test_category, test_title, test_body')
    .eq('id', cardId)
    .maybeSingle()
  if (!card) return fail(404, MESSAGES.not_found)

  if (!caller.isAdmin && card.booked_by !== caller.userId) return fail(403, MESSAGES.forbidden)
  if (card.status !== 'booked') return fail(409, MESSAGES.wrong_status)

  // ── The message, composed here and nowhere else ───────────────────────────
  //
  // Every ingredient comes from the card row or from a constant. Nothing the
  // caller sent contributes a character of the text.
  const message = buildInternalTestMessage({
    title: card.test_title,
    body: card.test_body,
    categoryLabel: testCategoryLabel(card.test_category),
    reference: card.card_ref,
  })

  // THE LABEL, RE-CHECKED ON THE WAY OUT. buildInternalTestMessage always adds
  // it, so this can only fire if that function is refactored into something
  // that does not — at which point the right behaviour is to produce no link at
  // all rather than a link to an unlabelled message.
  if (!hasInternalTestWarning(message)) {
    console.error('[customer-reviews:whatsapp] refusing to build an unlabelled test message')
    return fail(500, MESSAGES.build_failed)
  }

  const waMeUrl = buildWaMeUrl(target.digits, message)

  // ── Recording, only when explicitly asked ─────────────────────────────────
  //
  // THIS DOES NOT MARK THE CARD SENT. The RPC writes whatsapp_opened_at, a
  // counter and the target, and the database refuses to let it touch status —
  // see migration 20261017000000 §8, where the function has no status
  // assignment at all.
  //
  // It runs with the service role because the RPC is granted to service_role
  // alone: it takes the actor and the recipient as parameters, both of which
  // THIS route established (the actor from the session above, the recipient
  // from the allowlist above), and a browser that could call it directly could
  // supply either.
  if (record) {
    const admin = adminClient()
    if (!admin.ok) {
      // The NAMES of the missing variables, never their values.
      console.error('[customer-reviews:whatsapp] missing env:', admin.missing.join(', '))
      return fail(503, MESSAGES.unavailable)
    }
    const { error } = await admin.client.rpc('record_customer_review_test_card_whatsapp_opened', {
      p_card_id:  cardId,
      p_target:   target.e164,
      p_actor_id: caller.userId,
    })
    if (error) {
      // supabase-js never throws; the error arrives in the result, and a route
      // that ignores it reports success for a write that did not happen.
      console.error('[customer-reviews:whatsapp] could not record the open:', error.code)
      return fail(500, MESSAGES.record_failed)
    }
  }

  return ok({
    message,
    waMeUrl,
    // The label, so the screen can say who it is addressed to. The masked form
    // of the number is what the screen renders beside it; the full E.164 is
    // here because the caller supplied it and already knows it.
    target: { label: target.label, e164: target.e164 },
    recorded: record,
  })
}
