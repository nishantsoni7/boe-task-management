// GET /api/integrations/meta/sync
//
// The daily read of the owner's Meta ad account. Driven by Vercel Cron (see `crons` in vercel.json), which calls
// with GET and `Authorization: Bearer $CRON_SECRET`. It reads Meta with a view-only token and writes the meta_*
// tables with the service role; see src/lib/meta/sync.ts.
//
// With CRON_SECRET unset the route answers 503 and does nothing. With the Meta settings unset (META_ACCESS_TOKEN,
// META_AD_ACCOUNT_IDS) it answers 200 "not_configured": until the owner adds a token that is the expected state,
// and a red cron every morning would hide a real failure later.

import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { parseAccountIds } from '@/lib/meta/parse'
import { supabaseStore } from '@/lib/meta/store'
import { runMetaSync } from '@/lib/meta/sync'

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
    console.error('[meta/sync] CRON_SECRET is not set - refusing to run')
    return NextResponse.json({ error: 'The sync is not configured.' }, { status: 503 })
  }

  const provided = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!provided || !secretMatches(provided, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const token = process.env.META_ACCESS_TOKEN?.trim()
  const accountIds = parseAccountIds(process.env.META_AD_ACCOUNT_IDS)
  if (!token || accountIds.length === 0) {
    return NextResponse.json({ status: 'not_configured' })
  }

  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const result = await runMetaSync({ store: supabaseStore(svc), token, accountIds })
  return NextResponse.json(result, { status: result.status === 'failed' ? 502 : 200 })
}
