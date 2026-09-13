import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import {
  PURGE_MESSAGES,
  TEST_CARD_PURGE_BUCKET,
  runTestCardPurge,
  testCardPurgeService,
  type PurgeOutcome,
} from '@/lib/customerReviews/testCardPurge'

// PERMANENTLY DELETING ONE INTERNAL TEST RECORD.
//
// WHY A ROUTE. The record's files live in a private bucket that SQL cannot
// delete from, so the operation spans the database and the Storage API and
// needs the service role for both. See src/lib/customerReviews/testCardPurge.ts
// for the order of work, and migration 20261209000000 for the rules.
//
// WHO. This route authenticates the caller from their own session and checks
// they are active. It does NOT decide whether they may purge: the database
// functions resolve the administrator authority from the actor id this route
// passes — the session's user, never a value from the body — on START and
// again on FINISH.
//
// WHAT. Only customer_review_test_cards, and only a card the database still
// judges an internal draft. Custom review submissions are a different table
// and a different bucket; an id of one of those is simply not found.

export const runtime = 'nodejs'
export const maxDuration = 30

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

const fail = (status: number, message: string) =>
  NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store, private' } })

export async function POST(req: NextRequest) {
  const caller = await createClient()
  const { data: { user }, error: authError } = await caller.auth.getUser()
  if (authError || !user) return fail(401, PURGE_MESSAGES.unauthenticated)

  const { data: profile } = await caller
    .from('users')
    .select('is_active')
    .eq('id', user.id)
    .single()
  if (!profile || profile.is_active !== true) return fail(403, PURGE_MESSAGES.forbidden)

  let cardId: string
  try {
    const body = await req.json()
    const raw = body?.cardId
    if (typeof raw !== 'string' || !UUID_RE.test(raw)) return fail(400, PURGE_MESSAGES.bad_request)
    cardId = raw
  } catch {
    return fail(400, PURGE_MESSAGES.bad_request)
  }

  const admin = adminClient()
  if (!admin.ok) {
    console.error('[customer-reviews:test-card-purge] missing env:', admin.missing.join(', '))
    return fail(503, PURGE_MESSAGES.unavailable)
  }
  const service = admin.client

  const outcome = await runTestCardPurge(
    testCardPurgeService({
      rpc: (fn, args) => service.rpc(fn, args),
      bucket: service.storage.from(TEST_CARD_PURGE_BUCKET),
    }),
    user.id,
    cardId,
  )

  return respondTo(outcome, cardId)
}

function respondTo(outcome: PurgeOutcome, cardId: string) {
  switch (outcome.status) {
    case 'purged':
      return NextResponse.json({ purged: cardId }, { status: 200, headers: { 'Cache-Control': 'no-store, private' } })
    case 'refused':
      switch (outcome.reason) {
        case 'forbidden':       return fail(403, PURGE_MESSAGES.forbidden)
        case 'not_found':       return fail(404, PURGE_MESSAGES.not_found)
        case 'reward_attached': return fail(409, PURGE_MESSAGES.reward_attached)
        case 'not_eligible':    return fail(409, outcome.detail ?? PURGE_MESSAGES.not_eligible)
      }
      return fail(409, PURGE_MESSAGES.not_eligible)
    case 'failed':
      if (outcome.reason !== 'unknown') console.error('[customer-reviews:test-card-purge] incomplete:', outcome.reason)
      return fail(500, outcome.reason === 'unknown' ? PURGE_MESSAGES.failed : PURGE_MESSAGES.storage_failed)
  }
}
