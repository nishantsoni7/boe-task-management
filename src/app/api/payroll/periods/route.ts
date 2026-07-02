// GET /api/payroll/periods
// Returns all payroll periods with latest generation metadata.
// Admin only.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = SupabaseClient<any, any, any>

export type PayrollPeriodRecord = {
  id: string
  payroll_month: number
  payroll_year: number
  status: 'draft' | 'generated' | 'locked'
  [key: string]: unknown
}

export type GetOrCreatePeriodResult =
  | { outcome: 'created'; period: PayrollPeriodRecord }
  | { outcome: 'reused';  period: PayrollPeriodRecord }
  | { outcome: 'locked' }

// Core branching logic for POST /api/payroll/periods, factored out so it can
// be exercised directly against a real Supabase client in tests without going
// through HTTP/auth. See route.test.ts for coverage of all three outcomes.
//
// Invariant POST relies on without re-checking: this never inserts a second
// row for a month/year that already has a non-locked period — every non-error
// path either returns the pre-existing row ('reused'/'locked') or inserts
// exactly once ('created'). Callers can treat the result as the single source
// of truth for which HTTP status to return.
export async function getOrCreatePayrollPeriod(
  svc: Svc,
  month: number,
  year: number,
): Promise<GetOrCreatePeriodResult> {
  const { data: existing } = await svc
    .from('payroll_periods')
    .select('*')
    .eq('payroll_month', month)
    .eq('payroll_year', year)
    .maybeSingle()

  if (existing) {
    if (existing.status === 'locked') return { outcome: 'locked' }
    // Draft/Generated — reuse it. Attendance may have been re-uploaded since the
    // last generation; the caller should hit /api/payroll/generate next to
    // recompute results for this same period (upsert keeps one row per employee).
    return { outcome: 'reused', period: existing as PayrollPeriodRecord }
  }

  const { data: created, error: insertErr } = await svc
    .from('payroll_periods')
    .insert({ payroll_month: month, payroll_year: year, status: 'draft' })
    .select()
    .single()

  if (insertErr || !created) {
    throw new Error(`getOrCreatePayrollPeriod insert: ${insertErr?.message ?? 'no row returned'}`)
  }

  return { outcome: 'created', period: created as PayrollPeriodRecord }
}

export async function GET(req: NextRequest) {
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
    .select('role')
    .eq('id', caller.id)
    .single()
  if (callerProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data: periods, error: periodsErr } = await svc
    .from('payroll_periods')
    .select('*')
    .order('payroll_year', { ascending: false })
    .order('payroll_month', { ascending: false })

  if (periodsErr) return NextResponse.json({ error: periodsErr.message }, { status: 500 })

  // Fetch latest done generation per period for employee count + timestamp
  const { data: generations, error: genErr } = await svc
    .from('payroll_generation')
    .select('payroll_period_id, employee_count, completed_at')
    .eq('status', 'done')
    .order('completed_at', { ascending: false })

  if (genErr) return NextResponse.json({ error: genErr.message }, { status: 500 })

  // Keep only the first (latest) done generation per period
  const latestGen: Record<string, { employee_count: number; completed_at: string }> = {}
  for (const g of generations ?? []) {
    if (!latestGen[g.payroll_period_id]) {
      latestGen[g.payroll_period_id] = {
        employee_count: g.employee_count ?? 0,
        completed_at: g.completed_at,
      }
    }
  }

  const result = (periods ?? []).map(p => ({
    ...p,
    generated_employees: latestGen[p.id]?.employee_count ?? null,
    last_generated_at:   latestGen[p.id]?.completed_at ?? null,
  }))

  return NextResponse.json({ periods: result })
}

// POST /api/payroll/periods
// Creates a new payroll period for the given month/year.
// If a period already exists and is not locked, returns that existing period
// (200) instead of erroring — attendance can be re-uploaded and payroll
// regenerated any number of times against the same Draft/Generated period.
// Returns 409 only if the existing period is locked.
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
    .select('role')
    .eq('id', caller.id)
    .single()
  if (callerProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => null)
  const month = Number(body?.month)
  const year  = Number(body?.year)

  if (!month || month < 1 || month > 12 || !year || year < 2000 || year > 2100) {
    return NextResponse.json({ error: 'Invalid month or year' }, { status: 400 })
  }

  let result: GetOrCreatePeriodResult
  try {
    result = await getOrCreatePayrollPeriod(svc, month, year)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  if (result.outcome === 'locked') {
    return NextResponse.json({ error: `Payroll period for this month already exists` }, { status: 409 })
  }

  return NextResponse.json({ period: result.period }, { status: result.outcome === 'created' ? 201 : 200 })
}
