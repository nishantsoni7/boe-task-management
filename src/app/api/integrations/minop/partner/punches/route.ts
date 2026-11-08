// GET /api/integrations/minop/partner/punches
//
// The catch-up call for the operations ERP: every punch the machine has sent,
// oldest first, from where the caller stopped. The push to that ERP is the fast
// path; this is for after an outage, and for the first load of history.
//
//   Authorization: Bearer <MINOP_PARTNER_PULL_KEY>
//   ?since=<cursor from the last reply>   (leave out for the very first call)
//   &limit=<1..500, default 500>
//   &machineIds=7,8,9                      (optional: only these machine ids)
//
// Raw punches only: machine id, device, time. No names and nothing from
// attendance or payroll. With MINOP_PARTNER_PULL_KEY unset or shorter than 32
// characters the route answers 503 and reads nothing. Read-only.
// See src/lib/minop/partnerFeed.ts.

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { buildPartnerPage, parsePartnerQuery, partnerKeyMatches, PARTNER_MIN_SECRET_LENGTH, type PartnerRow } from '@/lib/minop/partnerFeed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const configuredKey = process.env.MINOP_PARTNER_PULL_KEY
  if ((configuredKey?.trim().length ?? 0) < PARTNER_MIN_SECRET_LENGTH) {
    return NextResponse.json({ error: 'The feed is not configured.' }, { status: 503, headers: NO_STORE })
  }
  if (!partnerKeyMatches(req.headers.get('authorization'), configuredKey)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  }

  const parsed = parsePartnerQuery(new URL(req.url))
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE })
  const { cursor, limit, machineIds } = parsed.query

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[minop/partner/punches] Supabase service configuration is missing')
    return NextResponse.json({ error: 'The feed could not read the punches.' }, { status: 500, headers: NO_STORE })
  }
  const svc = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })

  // Oldest first by when BOE received the punch, then by row id: several punches of one message share a
  // receipt time, so the row id keeps the cursor exact. The cursor values were checked by decodeCursor.
  let query = svc
    .from('minop_punches')
    .select('id, dvc_id, minop_user_id, punch_local, punch_at, first_seen_at')
    .order('first_seen_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit)
  if (cursor) query = query.or(`first_seen_at.gt.${cursor.t},and(first_seen_at.eq.${cursor.t},id.gt.${cursor.i})`)
  if (machineIds) query = query.in('minop_user_id', machineIds)

  const { data, error } = await query
  if (error) {
    console.error('[minop/partner/punches] read failed:', error.message)
    return NextResponse.json({ error: 'The feed could not read the punches.' }, { status: 500, headers: NO_STORE })
  }

  return NextResponse.json(buildPartnerPage((data ?? []) as PartnerRow[], parsed.query), { headers: NO_STORE })
}
