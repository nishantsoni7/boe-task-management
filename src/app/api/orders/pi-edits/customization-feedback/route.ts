// ── What happened to a Customize image attempt (Edit PI) ─────────────────────
//
// POST { attemptId, event, note? }
//   event: used | discarded | refined   → the attempt's outcome
//          correct | wrong              → the salesperson's 👍 / 👎 (+ note)
//
// Feeds the Learning page (20270420000000). Only the person who made the
// attempt can mark it: the update is filtered by created_by = the caller, with
// the service role (the tables have no policies). Answers 200 { recorded:
// false } when nothing was changed — the panel never blocks on this.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { isUuid } from '@/lib/orders/submissionPayload'
import { ATTEMPT_EVENTS, attemptPatchFor, type AttemptEvent } from '@/lib/orders/customizationLearning'
import { updateOwnAttempt } from '@/lib/orders/customizationLearningServer'

export const runtime = 'nodejs'

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ error: code, message }, { status })

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail(401, 'UNAUTHORIZED', 'Please sign in again.')

  let body: Record<string, unknown>
  try { body = (await req.json()) as Record<string, unknown> } catch { return fail(400, 'BAD_REQUEST', 'The request could not be read.') }
  const attemptId = typeof body.attemptId === 'string' ? body.attemptId : ''
  const event = body.event as AttemptEvent
  const note = typeof body.note === 'string' ? body.note : ''
  if (!isUuid(attemptId) || !ATTEMPT_EVENTS.includes(event)) return fail(400, 'BAD_REQUEST', 'The request could not be read.')

  const admin = adminClient()
  if (!admin.ok) return fail(500, 'SERVER_NOT_CONFIGURED', 'Image regeneration is not configured on this deployment.')

  const recorded = await updateOwnAttempt(admin.client, attemptId, { userId: user.id },
    attemptPatchFor(event, note, new Date().toISOString()))
  return NextResponse.json({ ok: true, recorded })
}
