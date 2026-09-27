// POST /api/payroll/lock
// Locks a payroll period (status: generated -> locked).
// Admin only.
//
// A month with no open attendance-review items locks exactly as before. A month
// WITH open items needs an acknowledgement of the current state, checked here on
// the server and recorded durably with the lock — see src/lib/payroll/lockPeriod.ts.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { lockPayrollPeriod } from '@/lib/payroll/lockPeriod'
import { istToday } from '@/lib/istDate'

export async function POST(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: { user: caller }, error: authErr } = await svc.auth.getUser(token)
  if (authErr || !caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: callerProfile } = await svc
    .from('users')
    .select('role, full_name')
    .eq('id', caller.id)
    .single()
  if (callerProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: Record<string, unknown>
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const r = await lockPayrollPeriod(
    svc,
    { id: caller.id, name: (callerProfile as { full_name?: string | null } | null)?.full_name ?? null },
    body,
    istToday(),
  )
  return NextResponse.json(r.body, { status: r.status })
}
