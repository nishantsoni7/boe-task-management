// POST /api/customer-reviews/generate — one batch of eight review drafts.
//
// THE ONLY PLACE A MODEL IS CALLED FOR THIS MODULE, together with its revision
// twin, and both are server routes for one reason: ANTHROPIC_API_KEY. The
// browser never sees it, never proxies through it, and cannot reach the
// provider on its own. Same provider, same transport and the same environment
// variable as /api/payroll/ask and /api/performance-audit.
//
// THREE LAYERS ASK THE SAME QUESTION, and all three have to agree:
//
//   the screen   hides the control unless caps.canVerify
//   this route   resolves `verify` before it reads the body or claims anything
//   the database claim_customer_review_generation() resolves it again before it
//                will let a credential be spent, and
//                create_customer_review_draft_batch() a third time before it
//                writes — and that one actually decides
//
// NO ROLE IS READ ANYWHERE. An administrator generates because the permission
// engine says they hold `verify`.
//
// ── WHAT THIS ROUTE IS AND IS NOT ──────────────────────────────────────────
//
// It is the wiring. The ORDER things happen in — claim, call, validate, write,
// finish — is runGeneration() in src/lib/customerReviews/generationRun.ts,
// because that order is the part with a concurrency property worth testing and
// a route handler is the hardest possible place to test one. Everything below
// is: who is asking, what did they ask for, and which real function fills each
// hole the orchestrator leaves.
//
// ── THE DOUBLE-CHARGE THIS CLOSES ──────────────────────────────────────────
//
// An earlier version looked the request key up here and called the provider if
// it found nothing. That stops a repeat that arrives a second later and does
// nothing at all about one that arrives in the same millisecond on another
// Vercel instance: both read nothing, both call Anthropic, one insert wins, BOE
// pays twice. The key is now CLAIMED by a single committed upsert before the
// call — see 20261027000000 — and only the claimant proceeds.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import {
  DRAFTS_PER_BATCH,
  GENERATION_MODEL,
  buildSystemPrompt,
  buildUserPrompt,
  validateGuidance,
} from '@/lib/customerReviews/draftGeneration'
import {
  ProviderRefusedError,
  runGeneration,
  type ClaimOutcome,
} from '@/lib/customerReviews/generationRun'

export const dynamic = 'force-dynamic'

const MESSAGES = {
  unauthenticated: 'Sign in to continue.',
  forbidden:       'You do not have permission to generate reviews.',
  bad_request:     'That request could not be read.',
  not_configured:  'Review generation is not configured on this deployment.',
  unavailable:     'The generator is unavailable right now. Please try again in a moment.',
} as const

const fail = (status: number, error: string) =>
  NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store, private' } })

const ok = (body: Record<string, unknown>) =>
  NextResponse.json(body, { status: 200, headers: { 'Cache-Control': 'no-store, private' } })

/** Eight reviews plus JSON scaffolding, with room to spare. */
const MAX_TOKENS = 4000

/**
 * How long a claim is held before another caller may take it over.
 *
 * Comfortably longer than a healthy provider call, because expiring early is
 * the expensive mistake: it would let a second caller in while the first is
 * still talking to Anthropic, which is the double charge this whole mechanism
 * exists to prevent. Expiring late only costs a verifier a wait.
 */
const CLAIM_TTL_SECONDS = 300

/** A uuid, and nothing else, so a caller cannot use the key as free storage. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  let requestKey: string
  try {
    const body = await req.json() as { guidance?: unknown; requestKey?: unknown } | null
    const checked = validateGuidance(body?.guidance)
    if (!checked.ok) return fail(400, checked.error)
    guidance = checked.guidance

    if (typeof body?.requestKey !== 'string' || !UUID.test(body.requestKey)) {
      return fail(400, MESSAGES.bad_request)
    }
    requestKey = body.requestKey
  } catch {
    return fail(400, MESSAGES.bad_request)
  }

  const admin = adminClient()
  if (!admin.ok) {
    // The NAMES of the missing variables, never their values.
    console.error('[customer-reviews:generate] missing env:', admin.missing.join(', '))
    return fail(503, MESSAGES.unavailable)
  }

  // ── 3. The credential, read before the claim is taken ─────────────────────
  //
  // BEFORE, and that ordering is deliberate. Claiming first and then finding no
  // key would hold a key for five minutes on behalf of a run that was never
  // going to happen — the caller would be told "already in progress" on their
  // next honest attempt. Reading it here costs nothing and means a
  // misconfigured deployment refuses cleanly, having claimed nothing.
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return fail(503, MESSAGES.not_configured)

  // ── 4. The sequence ───────────────────────────────────────────────────────
  const result = await runGeneration(
    {
      claim: async (key) => {
        const { data, error } = await admin.client.rpc('claim_customer_review_generation', {
          p_request_key: key,
          p_kind:        'generate',
          p_batch_id:    null,
          p_actor_id:    user.id,
          p_ttl_seconds: CLAIM_TTL_SECONDS,
        })
        if (error) throw Object.assign(new Error(error.message), { name: 'ClaimError' })
        // The function returns a single-row table.
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

      finish: async (key, state, batchId, count) => {
        const { error } = await admin.client.rpc('finish_customer_review_generation', {
          p_request_key: key,
          p_state:       state,
          p_batch_id:    batchId,
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
          console.error('[customer-reviews:generate] provider error:', response.status)
          throw Object.assign(new Error('provider error'), { name: 'ProviderHttpError' })
        }
        const data = await response.json()
        // A safety decline arrives as an ordinary 200 with no content, so the
        // reply is read defensively rather than indexed into.
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
      guidance,
      model: GENERATION_MODEL,
      buildSystem: buildSystemPrompt,
      buildUser: buildUserPrompt,
      maxTokens: MAX_TOKENS,
      insertBatch: async (drafts) => {
        const { data: batchId, error } = await admin.client.rpc(
          'create_customer_review_draft_batch',
          {
            p_guidance:    guidance,
            p_model:       GENERATION_MODEL,
            p_drafts:      drafts,
            p_actor_id:    user.id,
            p_request_key: requestKey,
          },
        )
        // supabase-js never throws; the error arrives in the result, and a route
        // that ignores it reports success for a write that did not happen.
        if (error) return { ok: false, code: error.code ?? '', message: error.message ?? '' }
        return { ok: true, batchId: batchId as string }
      },
    },
  )

  if (result.kind === 'completed') {
    return ok({ created: result.created, batchId: result.batchId, repeated: result.repeated })
  }
  if (result.kind === 'in_progress') return fail(result.status, result.message)
  return fail(result.status, result.message)
}

export const GENERATE_BATCH_SIZE = DRAFTS_PER_BATCH
