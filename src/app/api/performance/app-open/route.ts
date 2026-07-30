/**
 * POST /api/performance/app-open
 *
 * Records the first time an authenticated user opened a Task Management page on
 * an IST business date. Feeds the Performance "System Adoption" section; see
 * lib/performanceAdoption.ts for why this event exists and what was rejected as a
 * login proxy.
 *
 * Design constraints, all of them deliberate:
 *
 *   The user is resolved from the bearer token, never from the request body.
 *   A client cannot claim to be someone else, and — the case that matters — while
 *   an admin is using View As, the *admin* is recorded. Recording the impersonated
 *   employee would manufacture adoption history for someone who was not there,
 *   and would let a manager repair a subordinate's record by opening their account
 *   each morning.
 *
 *   The business date comes from the server clock in IST. A device with a wrong
 *   clock, or a laptop in another timezone, cannot file the event under the wrong
 *   day.
 *
 *   Exactly one row per user per business date, enforced by the unique constraint
 *   performance_app_opens_user_date_unique. The insert ignores duplicates, so the
 *   second and every later open of the day is a no-op rather than an error — the
 *   first timestamp is the one that means something.
 *
 *   Nothing here can break a page. Every failure path returns 200 with a
 *   `recorded: false` body, because a page that will not load because an optional
 *   metric could not be written is a worse outcome than a missing metric.
 */

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { buildAppOpenRow, isTaskManagementRoute } from '@/lib/performanceAdoption'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  // 401 here rather than a silent 200: an unauthenticated caller is a bug worth
  // surfacing, and there is no page to protect — the client fires this after auth.
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const client = sb()

    // The only source of identity. Note there is no `userId` read from the body
    // anywhere in this file.
    const { data: { user }, error: authError } = await client.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json().catch(() => ({})) as { route?: unknown }
    const route = typeof body.route === 'string' ? body.route.slice(0, 200) : null

    // Guard against a caller reporting a Performance page (or any other module) as
    // Task Management usage. Checking the metric must not satisfy the metric.
    if (route !== null && !isTaskManagementRoute(route)) {
      return NextResponse.json({ recorded: false, reason: 'not a Task Management route' })
    }

    const row = buildAppOpenRow(user.id, route)

    // ignoreDuplicates makes this ON CONFLICT DO NOTHING: the row that survives is
    // the first open of the day, which is the whole point of the metric.
    const { error } = await client
      .from('performance_app_opens')
      .upsert(row, { onConflict: 'user_id,business_date', ignoreDuplicates: true })

    if (error) {
      console.error('app-open insert failed:', error.message)
      return NextResponse.json({ recorded: false })
    }

    return NextResponse.json({ recorded: true, businessDate: row.business_date })
  } catch (err) {
    // Includes the case where the table does not exist yet.
    console.error('app-open unexpected failure:', err)
    return NextResponse.json({ recorded: false })
  }
}
