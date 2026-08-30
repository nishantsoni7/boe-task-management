// POST /api/customer-reviews/generate — the next batch of review drafts.
//
// THE ONLY PLACE A MODEL IS CALLED FOR THIS MODULE, and it is a server route
// for one reason: ANTHROPIC_API_KEY. The browser never sees it, never proxies
// through it, and cannot reach the provider on its own. Same provider, same
// transport and the same environment variable as /api/payroll/ask and
// /api/performance-audit — no second provider was introduced.
//
// THREE LAYERS ASK THE SAME QUESTION, and all three have to agree:
//
//   the screen   hides the section unless caps.canVerify
//   this route   resolves `verify` before it reads the body or calls anything
//   the database create_customer_review_draft_batch() resolves it again, and is
//                the one that actually decides
//
// The screen can be lied to, so it is the weakest. This route is where a
// credential would be spent, so it refuses BEFORE spending one. The function is
// the boundary.
//
// NO ROLE IS READ ANYWHERE. An administrator generates because the permission
// engine says they hold `verify`.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import {
  DRAFTS_PER_BATCH,
  GENERATION_MODEL,
  buildSystemPrompt,
  buildUserPrompt,
  validateDrafts,
  validateGuidance,
} from '@/lib/customerReviews/draftGeneration'

export const dynamic = 'force-dynamic'

// Prewritten, every one. A provider's error text can quote the request, so it
// goes to the server log and a sentence from this list goes to the browser.
const MESSAGES = {
  unauthenticated: 'Sign in to continue.',
  forbidden:       'You do not have permission to generate reviews.',
  bad_request:     'That request could not be read.',
  not_configured:  'Review generation is not configured on this deployment.',
  unavailable:     'The generator is unavailable right now. Please try again in a moment.',
  model_failed:    'The generator did not return a usable batch. Nothing was created. Please try again.',
  pool_not_empty:  'There are still reviews available. Generate the next batch once they have all been booked.',
  insert_failed:   'That batch could not be saved. Nothing was created.',
} as const

const fail = (status: number, error: string) =>
  NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store, private' } })

/** Roughly 20 reviews plus JSON scaffolding, with room to spare. */
const MAX_TOKENS = 8000

export async function POST(req: Request) {
  // ── 1. Who is asking ──────────────────────────────────────────────────────
  const caller = await createClient()
  const { data: { user }, error: authError } = await caller.auth.getUser()
  if (authError || !user) return fail(401, MESSAGES.unauthenticated)

  // is_active only. The role column is deliberately not selected: a value that
  // never arrives cannot be branched on, here or by a later edit.
  const { data: profile } = await caller
    .from('users')
    .select('is_active')
    .eq('id', user.id)
    .single()
  if (!profile || profile.is_active !== true) return fail(403, MESSAGES.forbidden)

  const { data: allowed } = await caller.rpc('resolve_permission', {
    p_user_id:    user.id,
    p_module_key: 'customer_review_requests',
    p_action_key: 'verify',
  })
  if (allowed !== true) return fail(403, MESSAGES.forbidden)

  // ── 2. What they asked for ────────────────────────────────────────────────
  let guidance: string
  try {
    const body = await req.json()
    const checked = validateGuidance((body as { guidance?: unknown } | null)?.guidance)
    if (!checked.ok) return fail(400, checked.error)
    guidance = checked.guidance
  } catch {
    return fail(400, MESSAGES.bad_request)
  }

  // ONLY THIS SUBMISSION'S GUIDANCE REACHES THE MODEL. There is no stored
  // previous batch, no accumulated context and no conversation: the request is
  // built from buildSystemPrompt() plus the string above, every time. A second
  // batch with empty guidance is a rejected request, not a silent repeat of the
  // first.
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return fail(503, MESSAGES.not_configured)

  const admin = adminClient()
  if (!admin.ok) {
    // The NAMES of the missing variables, never their values.
    console.error('[customer-reviews:generate] missing env:', admin.missing.join(', '))
    return fail(503, MESSAGES.unavailable)
  }

  // ── 3. The pool must be empty, checked before a credential is spent ───────
  //
  // The database checks this again inside the transaction and is what actually
  // decides — two verifiers pressing the button together both pass here. This
  // check exists so the ordinary case does not pay for a model call it was
  // always going to have thrown away.
  const { count: availableCount, error: countError } = await admin.client
    .from('customer_review_test_cards')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'available')
  if (countError) {
    console.error('[customer-reviews:generate] pool count failed:', countError.code)
    return fail(503, MESSAGES.unavailable)
  }
  if ((availableCount ?? 0) > 0) return fail(409, MESSAGES.pool_not_empty)

  // ── 4. The model ──────────────────────────────────────────────────────────
  let text: string
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      GENERATION_MODEL,
        max_tokens: MAX_TOKENS,
        system:     buildSystemPrompt(),
        messages:   [{ role: 'user', content: buildUserPrompt(guidance) }],
      }),
    })

    if (!response.ok) {
      console.error('[customer-reviews:generate] provider error:', response.status)
      return fail(502, MESSAGES.unavailable)
    }

    const data = await response.json()

    // A safety decline arrives as an ordinary 200 with no content, so the reply
    // is read defensively rather than indexed into.
    if (data?.stop_reason === 'refusal') {
      console.error('[customer-reviews:generate] provider declined the guidance')
      return fail(422, MESSAGES.model_failed)
    }

    text = (data?.content ?? [])
      .filter((block: { type?: string }) => block?.type === 'text')
      .map((block: { text?: string }) => block.text ?? '')
      .join('')
      .trim()
  } catch (err) {
    console.error('[customer-reviews:generate] provider call failed:', (err as Error)?.name)
    return fail(502, MESSAGES.unavailable)
  }

  // ── 5. Validate before anything is written ───────────────────────────────
  const checked = validateDrafts(text)
  if (!checked.ok) {
    // The reason names which draft and what was wrong; it describes our own
    // validation, not the provider's response body, so it is safe to return.
    console.error('[customer-reviews:generate] rejected batch:', checked.error)
    return fail(422, `${MESSAGES.model_failed} (${checked.error})`)
  }

  // ── 6. Insert, atomically ────────────────────────────────────────────────
  const { data: batchId, error: rpcError } = await admin.client.rpc(
    'create_customer_review_draft_batch',
    {
      p_guidance: guidance,
      p_model:    GENERATION_MODEL,
      p_drafts:   checked.drafts,
      p_actor_id: user.id,
    },
  )

  if (rpcError) {
    // supabase-js never throws; the error arrives in the result, and a route
    // that ignores it reports success for a write that did not happen.
    console.error('[customer-reviews:generate] batch insert failed:', rpcError.code)
    const message = `${rpcError.message ?? ''}`
    if (message.includes('POOL_NOT_EMPTY')) return fail(409, MESSAGES.pool_not_empty)
    if (message.includes('UNAUTHORIZED'))   return fail(403, MESSAGES.forbidden)
    return fail(500, MESSAGES.insert_failed)
  }

  return NextResponse.json(
    { created: DRAFTS_PER_BATCH, batchId },
    { status: 200, headers: { 'Cache-Control': 'no-store, private' } },
  )
}
