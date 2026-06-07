import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const ALLOWED_ROLES = ['admin', 'manager']

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
    return NextResponse.json({ error: 'Forbidden: admin or manager role required' }, { status: 403 })
  }

  const body = await req.json().catch(() => null)
  if (!body?.id) return NextResponse.json({ error: 'Missing employee id' }, { status: 400 })

  const { id, employee_code, joining_date, monthly_salary, office_timing } = body

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
  if (employee_code  !== undefined) patch.employee_code  = employee_code  || null
  if (joining_date   !== undefined) patch.joining_date   = joining_date   || null
  if (monthly_salary !== undefined) patch.monthly_salary = monthly_salary !== '' ? Number(monthly_salary) : null
  if (office_timing  !== undefined) patch.office_timing  = office_timing  || null

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
