// POST /api/customer-reviews/revise — regenerate one batch's pending drafts.
//
// The second and last place a model is called for this module, and it is a
// server route for the same single reason the generator is: ANTHROPIC_API_KEY.
// revise_customer_review_draft_batch() is service-role only, so a browser
// cannot reach the write either.
//
// WHAT A REVISION IS, AND WHAT IT IS CAREFULLY NOT
//
// A verifier reads twelve drafts, decides the set is not right, and asks again
// with different feedback. It replaces the TITLE AND BODY of every draft in
// that batch THAT IS STILL PENDING APPROVAL, and touches nothing else:
//
//   * an APPROVED review is one a person released to candidates, and it stays
//     byte-for-byte what they approved;
//   * a BOOKED, SENT, SUBMITTED, RETURNED or VERIFIED review is somebody's work
//     in progress or somebody's finished evidence.
//
// The database decides that, not this route: the function locks the batch's
// pending rows, counts them again inside the transaction, and refuses the whole
// revision if the count has moved. A count that moves is a REFUSAL, not a
// repair — silently revising the seven that are left would mean writing text
// the model composed for a different set.
//
// ── WHAT THE MODEL IS SHOWN, AND WHY ALL THREE ─────────────────────────────
//
//   the batch's ORIGINAL GUIDANCE  what this set was for
//   the CURRENT PENDING DRAFTS     what "these" refers to
//   the verifier's NEW FEEDBACK    what to change about them
//
// "Make these shorter" is not answerable without the drafts, and not answerable
// well without the subject matter they were written to. All three are fenced
// SEPARATELY and all three are untrusted context rather than instructions — the
// rules live in the system turn, which none of them can reach. See
// buildRevisionPrompt.
//
// ── THE DOUBLE-CHARGE THIS CLOSES ──────────────────────────────────────────
//
// Same as the generator's: two simultaneous submissions of one revision would
// both read the pending set, both call Anthropic, and one would be refused at
// the write — after BOE had paid twice. The request key is now CLAIMED before
// the call, and only the claimant proceeds.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import {
  MAX_BATCH_SIZE,
  maxTokensFor,
  GENERATION_MODEL,
  MISSING_FEEDBACK,
  buildRevisionPrompt,
  buildSystemPrompt,
  validateGuidance,
} from '@/lib/customerReviews/draftGeneration'
import {
  ProviderRefusedError,
  runRevision,
  type ClaimOutcome,
} from '@/lib/customerReviews/generationRun'

export const dynamic = 'force-dynamic'

const MESSAGES = {
  unauthenticated: 'Sign in to continue.',
  forbidden:       'You do not have permission to revise reviews.',
  bad_request:     'That request could not be read.',
  not_configured:  'Review generation is not configured on this deployment.',
  unavailable:     'The generator is unavailable right now. Please try again in a moment.',
} as const

const fail = (status: number, error: string) =>
  NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store, private' } })

const ok = (body: Record<string, unknown>) =>
  NextResponse.json(body, { status: 200, headers: { 'Cache-Control': 'no-store, private' } })

// A REVISION REWRITES AT MOST A WHOLE BATCH, so it is budgeted for one. It
// used to be a flat 4000, which was sized for the eight-draft era and was
// already generous for twelve because most revisions rewrite a handful. A batch
// is now up to twenty, and a rewrite of all twenty at 4000 tokens would be cut
// off mid-array — refused whole, after the call had been paid for. The exact
// pending count is not known until readBatch() runs, which is after the budget
// has to be fixed, so the ceiling is what is budgeted.
const MAX_TOKENS = maxTokensFor(MAX_BATCH_SIZE)
const CLAIM_TTL_SECONDS = 300
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: Request) {
  // ── 1. Who is asking ──────────────────────────────────────────────────────
  const caller = await createClient()
  const { data: { user }, error: authError } = await caller.auth.getUser()
  if (authError || !user) return fail(401, MESSAGES.unauthenticated)

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
  let batchId: string
  let feedback: string
  let requestKey: string
  try {
    const body = await req.json() as
      { batchId?: unknown; feedback?: unknown; requestKey?: unknown } | null

    if (typeof body?.batchId !== 'string' || !UUID.test(body.batchId)) {
      return fail(400, MESSAGES.bad_request)
    }
    batchId = body.batchId

    // FRESH FEEDBACK, EVERY TIME. Nothing is stored between revisions and
    // nothing is defaulted: an empty field is a refused request, not a silent
    // repeat of what was said last time.
    const checked = validateGuidance(body?.feedback, MISSING_FEEDBACK)
    if (!checked.ok) return fail(400, checked.error)
    feedback = checked.guidance

    if (typeof body?.requestKey !== 'string' || !UUID.test(body.requestKey)) {
      return fail(400, MESSAGES.bad_request)
    }
    requestKey = body.requestKey
  } catch {
    return fail(400, MESSAGES.bad_request)
  }

  const admin = adminClient()
  if (!admin.ok) {
    console.error('[customer-reviews:revise] missing env:', admin.missing.join(', '))
    return fail(503, MESSAGES.unavailable)
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return fail(503, MESSAGES.not_configured)

  // ── 3. The sequence ───────────────────────────────────────────────────────
  const result = await runRevision(
    {
      claim: async (key) => {
        const { data, error } = await admin.client.rpc('claim_customer_review_generation', {
          p_request_key: key,
          p_kind:        'revise',
          p_batch_id:    batchId,
          p_actor_id:    user.id,
          p_ttl_seconds: CLAIM_TTL_SECONDS,
        })
        if (error) throw Object.assign(new Error(error.message), { name: 'ClaimError' })
        const row = (Array.isArray(data) ? data[0] : data) as {
          outcome: string; batch_id: string | null; result_count: number | null; attempts: number | null
        } | null
        if (!row) throw Object.assign(new Error('empty claim'), { name: 'ClaimError' })
        if (row.outcome === 'completed') {
          return { outcome: 'completed', batchId: row.batch_id as string, resultCount: row.result_count }
        }
        if (row.outcome === 'in_progress') {
          return { outcome: 'in_progress', attempts: row.attempts }
        }
        return { outcome: 'claimed', attempts: row.attempts ?? 1 } satisfies ClaimOutcome
      },

      finish: async (key, state, resultBatchId, count) => {
        const { error } = await admin.client.rpc('finish_customer_review_generation', {
          p_request_key: key,
          p_state:       state,
          p_batch_id:    resultBatchId,
          p_count:       count,
        })
        if (error) throw Object.assign(new Error(error.message), { name: 'FinishError' })
      },

      provider: async ({ system, user: userTurn, maxTokens }) => {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type':      'application/json',
            'x-api-key':         apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model:      GENERATION_MODEL,
            max_tokens: maxTokens,
            system,
            messages:   [{ role: 'user', content: userTurn }],
          }),
        })
        if (!response.ok) {
          console.error('[customer-reviews:revise] provider error:', response.status)
          throw Object.assign(new Error('provider error'), { name: 'ProviderHttpError' })
        }
        const data = await response.json()
        if (data?.stop_reason === 'refusal') throw new ProviderRefusedError()
        return (data?.content ?? [])
          .filter((block: { type?: string }) => block?.type === 'text')
          .map((block: { text?: string }) => block.text ?? '')
          .join('')
          .trim()
      },

      log: (...parts) => console.error(...(parts as [unknown])),
    },
    {
      requestKey,
      batchId,
      feedback,
      model: GENERATION_MODEL,
      buildSystem: buildSystemPrompt,
      buildRevision: buildRevisionPrompt,
      maxTokens: MAX_TOKENS,

      readBatch: async () => {
        const { data: batch, error: batchError } = await admin.client
          .from('customer_review_draft_batches')
          .select('id, guidance')
          .eq('id', batchId)
          .maybeSingle()
        if (batchError) {
          console.error('[customer-reviews:revise] batch read failed:', batchError.code)
          return { ok: false as const, reason: 'unavailable' as const }
        }
        if (!batch) return { ok: false as const, reason: 'not_found' as const }

        const { data: pending, error: pendingError } = await admin.client
          .from('customer_review_test_cards')
          .select('id, card_ref, test_title, test_body')
          .eq('batch_id', batchId)
          .eq('status', 'pending_approval')
          // THE SAME ORDER THE FUNCTION USES. It locks and rewrites its pending
          // rows ordered by card_ref, so the nth replacement has to be the nth
          // draft the model was shown — otherwise a revision shuffles the set.
          .order('card_ref', { ascending: true })
        if (pendingError) {
          console.error('[customer-reviews:revise] pending read failed:', pendingError.code)
          return { ok: false as const, reason: 'unavailable' as const }
        }

        const rows = pending ?? []
        if (rows.length === 0) return { ok: false as const, reason: 'nothing_pending' as const }
        if (rows.length > MAX_BATCH_SIZE) {
          // Not reachable through the product — a batch holds at most
          // MAX_BATCH_SIZE — but a bounded prompt is a bounded prompt whatever
          // put the rows there.
          console.error('[customer-reviews:revise] batch holds', rows.length, 'pending drafts')
          return { ok: false as const, reason: 'unavailable' as const }
        }
        return {
          ok: true as const,
          guidance: batch.guidance as string,
          pending: rows.map(r => ({ title: r.test_title as string, body: r.test_body as string })),
        }
      },

      applyRevision: async (drafts) => {
        const { data: revised, error } = await admin.client.rpc(
          'revise_customer_review_draft_batch',
          {
            p_batch_id:    batchId,
            p_guidance:    feedback,
            p_model:       GENERATION_MODEL,
            p_drafts:      drafts,
            p_actor_id:    user.id,
            p_request_key: requestKey,
          },
        )
        if (error) return { ok: false, code: error.code ?? '', message: error.message ?? '' }
        return { ok: true, revised: (revised as number) ?? 0 }
      },
    },
  )

  if (result.kind === 'completed') {
    return ok({ revised: result.revised, batchId: result.batchId, repeated: result.repeated })
  }
  return fail(result.status, result.message)
}
