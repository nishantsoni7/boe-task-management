// GET /api/integrations/meta/review
//
// The Monday review of the Meta ad account. Driven by Vercel Cron (see `crons` in vercel.json), which calls with GET
// and `Authorization: Bearer $CRON_SECRET`. A week reviewed once is not asked for again, so a second call costs
// nothing; a failed week can be run again. See src/lib/meta/review.ts.

import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { anthropicAsk, runMetaReview, supabaseReviewStore } from '@/lib/meta/review'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    console.error('[meta/review] CRON_SECRET is not set - refusing to run')
    return NextResponse.json({ error: 'The review is not configured.' }, { status: 503 })
  }

  const provided = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!provided || !secretMatches(provided, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ status: 'not_configured' })

  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const result = await runMetaReview({ store: supabaseReviewStore(svc), ask: anthropicAsk(apiKey) })
  return NextResponse.json(result, { status: result.status === 'failed' ? 502 : 200 })
}
