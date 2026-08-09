// GET   /api/payroll/participation   — who takes part in Attendance & Payroll
// PATCH /api/payroll/participation   — include or exclude one member
//
// Admin only, both verbs. GET is deliberately NOT opened to the wider Payroll
// module access that /api/payroll/periods and /api/payroll/results use: this
// route returns monthly_salary alongside every employee's name, so it answers
// the same question a salary list does. Members named in Control Center →
// Module Visibility → Custom can read payroll results; they may not read the
// company's salary roster, and they may not change who gets paid.
//
// The flag itself is `users.payroll_active`, which has existed since migration
// 20260607000100 — this route adds no column and no second source of truth. See
// src/lib/payroll/participation.ts for what exclusion does and does not mean.
//
// Why a Payroll route rather than reusing PATCH /api/update-employee: that route
// is the Employee Master form and patches whatever field set it is handed,
// including monthly_salary. Excluding somebody from payroll should not travel
// through an endpoint that can also change their pay, and a single-purpose route
// is what lets the response state the resulting participation back to the caller.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { participatesInPayroll } from '@/lib/payroll/participation'

async function requirePayrollAdmin(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return null

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: { user }, error } = await svc.auth.getUser(token)
  if (error || !user) return null

  const { data: profile } = await svc.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return null

  return { svc, callerId: user.id }
}

export type ParticipationMember = {
  id: string
  full_name: string
  employee_code: string | null
  monthly_salary: number | null
  /** Whether Attendance & Payroll currently process this member. */
  participating: boolean
  /** The account itself. An excluded member is normally still active — that is the point. */
  is_active: boolean
}

export async function GET(req: NextRequest) {
  const ctx = await requirePayrollAdmin(req)
  if (!ctx) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Soft-deleted rows are left out entirely: they are not people an admin can
  // meaningfully include again, and listing them would pad the excluded count
  // with accounts that were removed for unrelated reasons.
  const { data, error } = await ctx.svc
    .from('users')
    .select('id, full_name, employee_code, monthly_salary, payroll_active, is_active, is_deleted')
    .or('is_deleted.eq.false,is_deleted.is.null')
    .order('full_name')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const members: ParticipationMember[] = (data ?? []).map(u => ({
    id:             u.id,
    full_name:      u.full_name,
    employee_code:  u.employee_code ?? null,
    monthly_salary: u.monthly_salary ?? null,
    participating:  participatesInPayroll(u),
    is_active:      u.is_active !== false,
  }))

  return NextResponse.json({ members })
}

export async function PATCH(req: NextRequest) {
  const ctx = await requirePayrollAdmin(req)
  if (!ctx) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: { employee_id?: string; participating?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { employee_id, participating } = body
  if (!employee_id) {
    return NextResponse.json({ error: 'employee_id is required' }, { status: 400 })
  }
  if (typeof participating !== 'boolean') {
    return NextResponse.json({ error: 'participating must be true or false' }, { status: 400 })
  }

  const { data: target } = await ctx.svc
    .from('users')
    .select('id, full_name')
    .eq('id', employee_id)
    .single()

  if (!target) return NextResponse.json({ error: 'Employee not found' }, { status: 404 })

  // Only this one column is written. Nothing here touches is_active, role or any
  // other module's access — an excluded member keeps their login and their work.
  // Nothing here touches payroll_results or attendance_records either, so every
  // historical figure, locked or not, survives the change untouched.
  const { error } = await ctx.svc
    .from('users')
    .update({ payroll_active: participating })
    .eq('id', employee_id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    employee_id,
    full_name: target.full_name,
    participating,
  })
}
