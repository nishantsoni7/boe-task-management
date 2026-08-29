import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { normalizeWhatsAppNumber } from '@/lib/customerReviews/contact'
import { fingerprintRecipient } from '@/lib/customerReviews/recipientPrivacy'
import { buildInternalTestMessage, buildWaMeUrl, hasInternalTestWarning } from '@/lib/customerReviews/internalTest'
import { testCategoryLabel } from '@/lib/customerReviews/types'

// THE ONLY PLACE A wa.me LINK IS BUILT.
//
// POST takes a card id, a number the tester typed, and their confirmation, and
// returns the message and the link. It records the open only when asked to.
//
// ANY VALID NUMBER, AND WHAT THAT DOES NOT MEAN
// ---------------------------------------------
// There is no allowlist. An authorized tester enters whatever international
// number they want to test against. "Any number" is a widening of who can be
// reached; it is not a widening of who can reach them, and every other control
// is unchanged or tighter:
//
//   * ONLY an active employee holding customer_review_requests.use, and ONLY
//     for a card they themselves hold. A tester cannot produce a link for
//     somebody else's card — checked here AND by the card's own RLS, since the
//     read below runs as the caller.
//   * The number is normalised and validated HERE, on the server, whatever the
//     browser did with it. Malformed, too short, too long, or missing a country
//     code: refused, with no link in the response.
//   * The tester must have ticked the confirmation. It is a required field of
//     the request, not a courtesy on the form.
//   * The message is composed here from the card row and two constants, and it
//     carries the permanent internal-test label. Nothing in the request body
//     contributes a character of it.
//
// WHY THE SERVER STILL BUILDS THE LINK
// ------------------------------------
// Because everything above is only true if this is the only path. If the
// browser assembled the URL, the validation, the confirmation and the label
// would each be a suggestion that a devtools console could skip.
//
// WHAT THIS ROUTE DOES NOT DO, AND CANNOT
// ---------------------------------------
//   * IT DOES NOT SEND ANYTHING. There is no WhatsApp Business API client in
//     this repository, no token, no outbound HTTP call of any kind in this
//     file. The response body is a string.
//   * IT DOES NOT MARK A CARD AS SENT. `record: true` writes
//     whatsapp_opened_at, a counter and a MASKED recipient — and touches no
//     status. The tester's claim that they pressed send is a different call
//     (confirm_customer_review_test_card_sent), made by a person, afterwards.
//   * IT DOES NOT OPEN WHATSAPP. It returns a URL. Whether anything navigates
//     to it is the browser's business, and no test in this module does.
//   * IT DOES NOT STORE OR LOG THE NUMBER. What reaches the database is four
//     digits and a non-reversible fingerprint. No log line, no error message
//     and no event detail in this file contains any part of a number.

export const runtime = 'nodejs'

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** The longest a typed number can be before it is not a typo. */
const MAX_INPUT_LENGTH = 40

/**
 * Every sentence this route can return, and it returns nothing else.
 *
 * An allow-list rather than a formatter: the alternative is a template that one
 * day interpolates a value somebody forgot was caller-influenced. In this route
 * that value would be a phone number.
 *
 * The one exception is the VALIDATION message, which comes from
 * normalizeWhatsAppNumber — and that function is written so that none of its
 * error strings contains any part of the input either. Its tests assert it.
 */
const MESSAGES = {
  unauthenticated: 'Sign in to continue.',
  forbidden:       'You do not have permission to run internal tests.',
  not_found:       'That test card is not available.',
  wrong_status:    'You can only open WhatsApp for a card you currently hold.',
  bad_request:     'That request could not be processed.',
  not_confirmed:   'Tick the confirmation before preparing the message.',
  unavailable:     'Internal testing is not configured on this deployment.',
  build_failed:    'The test message could not be prepared. Try again.',
  record_failed:   'That could not be recorded. Try again.',
} as const

/**
 * THE CONFIRMATION, WORD FOR WORD.
 *
 * Exported so the checkbox on the screen and the check on the server are
 * provably the same sentence, and so a change to it is a change to one visible
 * line rather than to two that might drift.
 */
export const RECIPIENT_CONFIRMATION =
  'I confirm this number may receive an internal BOE test message and the content will not be published as a customer review.'

const fail = (status: number, message: string) =>
  NextResponse.json({ error: message }, {
    status,
    // Private data, and a per-caller answer. Nothing about this response may be
    // cached by a proxy or a browser.
    headers: { 'Cache-Control': 'no-store, private' },
  })

const ok = (body: Record<string, unknown>) =>
  NextResponse.json(body, { status: 200, headers: { 'Cache-Control': 'no-store, private' } })

type Caller = { userId: string; isAdmin: boolean }

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
 * Build the link for one card and one number.
 *
 * Body: { cardId, number, confirmed, record?: boolean }
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
  let typedNumber: string
  let confirmed: boolean
  let record: boolean
  try {
    const body = await req.json()
    if (typeof body !== 'object' || body === null) return fail(400, MESSAGES.bad_request)
    const fields = body as Record<string, unknown>

    const rawId = fields.cardId
    if (typeof rawId !== 'string' || !UUID_RE.test(rawId)) return fail(400, MESSAGES.bad_request)
    cardId = rawId

    const rawNumber = fields.number
    if (typeof rawNumber !== 'string' || rawNumber.length > MAX_INPUT_LENGTH) {
      return fail(400, MESSAGES.bad_request)
    }
    typedNumber = rawNumber

    // STRICTLY TRUE. `confirmed: 'yes'`, `1`, or a missing field are all not a
    // confirmation — a truthy check would let a client tick the box by
    // accident, which is the opposite of what a deliberate confirmation is for.
    confirmed = fields.confirmed === true
    record = fields.record === true
  } catch {
    return fail(400, MESSAGES.bad_request)
  }

  // ── THE CONFIRMATION, BEFORE ANY WORK IS DONE WITH THE NUMBER ─────────────
  if (!confirmed) return fail(400, MESSAGES.not_confirmed)

  // ── THE NUMBER, VALIDATED HERE WHATEVER THE BROWSER DID ───────────────────
  //
  // Checked before the card is read, so there is no branch in which a link is
  // built and then discarded — a link that exists in a variable is a link a
  // later edit could return. The error is the validator's own sentence, which
  // never contains any part of the input.
  const normalized = normalizeWhatsAppNumber(typedNumber)
  if (!normalized.ok) return fail(400, normalized.error)

  // ── May they act on THIS card ─────────────────────────────────────────────
  //
  // Read as the caller. The card's SELECT policy decides, so a card belonging
  // to somebody else returns no row and this route cannot tell the difference
  // between "not yours" and "does not exist" — which is the answer the tester
  // should get too. The ownership check below is the second half: RLS lets a
  // verifier READ every card, and reading is not holding.
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
  // caller sent contributes a character of the text — the number reaches the
  // URL's path, never its body.
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

  const waMeUrl = buildWaMeUrl(normalized.digits, message)

  // ── Recording, only when explicitly asked ─────────────────────────────────
  //
  // THIS DOES NOT MARK THE CARD SENT. The RPC writes whatsapp_opened_at, a
  // counter and the MASKED recipient, and the database refuses to let it touch
  // status — see migration 20261017000000 §8, where the function has no status
  // assignment at all.
  //
  // WHAT GOES TO THE DATABASE IS NOT THE NUMBER: four digits and a
  // non-reversible fingerprint, computed here. The full E.164 form does not
  // leave this function.
  if (record) {
    const admin = adminClient()
    if (!admin.ok) {
      // The NAMES of the missing variables, never their values.
      console.error('[customer-reviews:whatsapp] missing env:', admin.missing.join(', '))
      return fail(503, MESSAGES.unavailable)
    }

    const stored = fingerprintRecipient(normalized.e164)
    if (!stored.ok) {
      // FAIL CLOSED rather than recording a weaker value. The reason is a
      // fixed word from a closed set and names no number.
      console.error('[customer-reviews:whatsapp] cannot fingerprint recipient:', stored.reason)
      return fail(503, MESSAGES.unavailable)
    }

    const { error } = await admin.client.rpc('record_customer_review_test_card_whatsapp_opened', {
      p_card_id: cardId,
      p_target_fingerprint: stored.value.fingerprint,
      p_target_last_four: stored.value.lastFour,
      p_actor_id: caller.userId,
    })
    if (error) {
      // supabase-js never throws; the error arrives in the result, and a route
      // that ignores it reports success for a write that did not happen. The
      // CODE is logged, never the message, which could quote a parameter.
      console.error('[customer-reviews:whatsapp] could not record the open:', error.code)
      return fail(500, MESSAGES.record_failed)
    }
  }

  return ok({
    message,
    waMeUrl,
    // THE MASKED FORM ONLY. The caller already knows the number they typed;
    // echoing it back would put it in one more response body, one more browser
    // memory profile and one more devtools network log for no purpose.
    target: { lastFour: normalized.e164.slice(-4) },
    recorded: record,
  })
}
