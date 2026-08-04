import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

// Admin only. This route writes monthly_salary and payroll_notes among other
// employee-master fields, so a manager holding it meant a manager could set any
// employee's pay — which payroll then snapshots at generation time. The only
// screen that calls it (attendance Employee Master) is admin-gated already.
const ALLOWED_ROLES = ['admin']

export async function PATCH(req: NextRequest) {
  const authHeader  = req.headers.get('authorization') ?? ''
  const callerToken = authHeader.replace('Bearer ', '').trim()
  if (!callerToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const serviceClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: { user: caller }, error: callerError } = await serviceClient.auth.getUser(callerToken)
  if (callerError || !caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Check caller role
  const { data: callerProfile } = await serviceClient
    .from('users')
    .select('role')
    .eq('id', caller.id)
    .single()

  if (!callerProfile || !ALLOWED_ROLES.includes(callerProfile.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => null)
  if (!body?.id) return NextResponse.json({ error: 'Missing employee id' }, { status: 400 })

  const { id, employee_code, joining_date, monthly_salary, office_timing, fingerprint_employee_code, payroll_active, employment_type, payroll_notes, performance_tracking_enabled, performance_tracking_note } = body

  // Confirm employee exists in users table
  const { data: target, error: targetError } = await serviceClient
    .from('users')
    .select('id')
    .eq('id', id)
    .single()

  if (targetError || !target) {
    return NextResponse.json({ error: 'Employee not found' }, { status: 404 })
  }

  const patch: Record<string, unknown> = {}
  if (employee_code             !== undefined) patch.employee_code             = employee_code             || null
  if (joining_date              !== undefined) patch.joining_date              = joining_date              || null
  if (monthly_salary            !== undefined) patch.monthly_salary            = monthly_salary !== '' ? Number(monthly_salary) : null
  if (office_timing             !== undefined) patch.office_timing             = office_timing             || null
  if (fingerprint_employee_code !== undefined) patch.fingerprint_employee_code = fingerprint_employee_code || null
  if (payroll_active            !== undefined) patch.payroll_active            = Boolean(payroll_active)
  if (employment_type           !== undefined) patch.employment_type           = employment_type || null
  if (payroll_notes             !== undefined) patch.payroll_notes             = payroll_notes   || null
  // Performance reporting eligibility. Deliberately distinct from payroll_active:
  // holding someone out of the Performance report must never change what they are
  // paid, and vice versa.
  if (performance_tracking_enabled !== undefined) patch.performance_tracking_enabled = Boolean(performance_tracking_enabled)
  if (performance_tracking_note    !== undefined) patch.performance_tracking_note    = performance_tracking_note || null

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const { error: updateError } = await serviceClient
    .from('users')
    .update(patch)
    .eq('id', id)

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
