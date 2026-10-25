// ── Understand a customization before a picture is made (Edit PI) ────────────
//
// POST { submissionId, sourcePath, comment, productName?, dimensions?, material?, references? }
//   → { instruction, assumptions[] }
//
// Claude looks at the line's current picture (and up to two reference
// pictures) with the salesperson's words and writes the change out as exact
// physical instructions for the image model — "both pedestals stand on ONE
// continuous floor plate" rather than "bottom plate combined". The page shows
// it as "Understood as", editable, BEFORE any image request is paid for.
//
// LEARNING (20270420000000): the active house rules and the approved examples
// most like this request go into the request, and the attempt is recorded for
// the Learning page — both best effort, so without the tables it works as
// before. Same gate as the photo upload. ANTHROPIC_API_KEY is read
// here and never leaves the server. Refusals fall back server-side
// (`fallbacks: "default"`) so a policy false positive still gets an answer.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { isUuid } from '@/lib/orders/submissionPayload'
import { isCanonicalPiImageKey } from '@/lib/orders/piImageKey'
import {
  INSTRUCTION_MESSAGES, INTERPRETATION_SCHEMA, INTERPRET_SYSTEM_PROMPT, PI_INTERPRET_MODEL,
  buildInterpretRequest, instructionProblem, parseReferences, readInterpretation,
} from '@/lib/orders/customizationImage'
import {
  SOURCE_MESSAGES, loadSourcePicture, makeRateLimiter, mayChangePiPhotos,
} from '@/lib/orders/customizationImageServer'
import { buildLearningContext } from '@/lib/orders/customizationLearning'
import { loadLearningFor, recordAttempt } from '@/lib/orders/customizationLearningServer'

export const runtime = 'nodejs'
export const maxDuration = 60

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ error: code, message }, { status })

const rateLimited = makeRateLimiter(10)
const PROVIDER_TIMEOUT_MS = 50_000

type Answer = { model?: string; stop_reason?: string; content?: { type: string; text?: unknown }[] }
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

const NOT_UNDERSTOOD = 'The customization could not be worked out. Reword it, or edit the instruction yourself and regenerate.'

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail(401, 'UNAUTHORIZED', 'Please sign in again.')

  let body: Record<string, unknown>
  try { body = (await req.json()) as Record<string, unknown> } catch { return fail(400, 'BAD_REQUEST', 'The request could not be read.') }
  const submissionId = str(body.submissionId, 64)
  const itemId = str(body.itemId, 64)
  const sourcePath = str(body.sourcePath, 400)
  const comment = str(body.comment, 4000)
  const productName = str(body.productName, 300)
  const dimensions = str(body.dimensions, 500)
  const material = str(body.material, 1000)
  const references = parseReferences(body.references)
  if (!isUuid(submissionId) || !isUuid(itemId) || !isCanonicalPiImageKey(sourcePath, { submissionId }) || references === null) {
    return fail(400, 'BAD_REQUEST', 'The request could not be read.')
  }
  const problem = instructionProblem(comment)
  if (problem) return fail(400, 'INSTRUCTION', INSTRUCTION_MESSAGES[problem])

  const may = await mayChangePiPhotos(authClient, submissionId)
  if (may === 'not_found') return fail(404, 'NOT_FOUND', 'This PI is not available to you.')
  if (may === 'forbidden') return fail(403, 'FORBIDDEN', 'You cannot change the photos on this PI.')

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return fail(503, 'not_configured', 'Understanding customizations is not set up yet. Ask your administrator to configure it.')
  const admin = adminClient()
  if (!admin.ok) return fail(500, 'SERVER_NOT_CONFIGURED', 'Image regeneration is not configured on this deployment.')
  if (rateLimited(user.id)) return fail(429, 'RATE_LIMITED', 'Too many requests in a minute. Wait a moment and try again.')

  // The picture and what the company has taught so far (rules + similar examples), together.
  const [source, learning] = await Promise.all([
    loadSourcePicture(admin.client, sourcePath),
    loadLearningFor(admin.client, { comment, productName }),
  ])
  if (!source.ok) return fail(source.code === 'SOURCE_MISSING' ? 404 : 422, source.code, SOURCE_MESSAGES[source.code])

  // One attempt, inside the route's time: a timeout is answered, not retried.
  // Plain fetch, like every other Claude call in this repository: no AI SDK is
  // a dependency here (src/app/finance/expenses/expenseSurfaces.test.ts).
  let res: Response
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      body: JSON.stringify({
        model: PI_INTERPRET_MODEL,
        max_tokens: 4000,
        fallbacks: 'default',
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: INTERPRETATION_SCHEMA } },
        system: INTERPRET_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: source.jpeg.toString('base64') } },
            ...references.map(r => ({ type: 'image', source: { type: 'base64', media_type: r.mimeType, data: r.base64 } })),
            { type: 'text', text: buildInterpretRequest({
              comment, productName, dimensions, material,
              referenceCount: references.length,
              learning: buildLearningContext(learning.rules, learning.examples),
            }) },
          ],
        }],
      }),
    })
  } catch {
    return fail(504, 'timeout', 'Working out the customization took too long. Please try again.')
  }

  if (!res.ok) {
    const detail = await res.json().catch(() => null) as { error?: { type?: string } } | null
    console.error('[pi-interpret-customization] provider refused', { status: res.status, type: detail?.error?.type })
    if (res.status === 401 || res.status === 403) {
      return fail(503, 'invalid_key', 'The service rejected this site’s credentials. Ask your administrator to check ANTHROPIC_API_KEY.')
    }
    if (res.status === 429 || res.status === 529) return fail(429, 'rate_limited', 'The service is busy right now. Wait a moment and try again.')
    return fail(502, 'provider_error', NOT_UNDERSTOOD)
  }

  const answer = await res.json().catch(() => null) as Answer | null
  if (!answer || answer.stop_reason === 'refusal' || answer.stop_reason === 'max_tokens') {
    console.error('[pi-interpret-customization] no answer', { stop: answer?.stop_reason, model: answer?.model })
    return fail(422, 'NOT_UNDERSTOOD', NOT_UNDERSTOOD)
  }
  const text = (answer.content ?? []).flatMap(b => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('')
  let parsed: unknown = null
  try { parsed = JSON.parse(text) } catch { /* answered below */ }
  const interpretation = readInterpretation(parsed)
  if (!interpretation) return fail(422, 'NOT_UNDERSTOOD', NOT_UNDERSTOOD)

  // Recorded for the Learning page; best effort, never a reason to fail.
  const attemptId = await recordAttempt(admin.client, {
    submission_id: submissionId,
    item_id: itemId,
    created_by: user.id,
    source_path: sourcePath,
    comment: comment.trim().slice(0, 1500),
    product_name: productName.trim() || null,
    pi_dimensions: dimensions.trim() || null,
    pi_material: material.trim() || null,
    reference_count: references.length,
    understood_instruction: interpretation.instruction,
    understood_assumptions: interpretation.assumptions,
    applied_rule_ids: learning.rules.map(r => r.id),
    applied_example_ids: learning.examples.map(e => e.id),
  })

  return NextResponse.json({
    ok: true,
    ...interpretation,
    attemptId,
    applied: { rules: learning.rules.length, examples: learning.examples.length },
  })
}
