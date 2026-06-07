import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const ALLOWED_ROLES = ['admin', 'manager']

export async function POST(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: { user: caller }, error: authErr } = await svc.auth.getUser(token)
  if (authErr || !caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: callerProfile } = await svc.from('users').select('role').eq('id', caller.id).single()
  if (!callerProfile || !ALLOWED_ROLES.includes(callerProfile.role)) {
    return NextResponse.json({ error: 'Forbidden: admin or manager role required' }, { status: 403 })
  }

  const body = await req.json().catch(() => null)
  const { full_name, employee_code, fingerprint_employee_code, team } = body ?? {}

  if (!full_name?.trim())     return NextResponse.json({ error: 'Name is required' }, { status: 400 })
  if (!employee_code?.trim()) return NextResponse.json({ error: 'Employee HR code is required' }, { status: 400 })

  const empCode = employee_code.trim()
  const fpCode  = fingerprint_employee_code?.trim() || null

  // Check duplicate employee_code
  const { data: dupCode } = await svc
    .from('users').select('id').eq('employee_code', empCode).maybeSingle()
  if (dupCode) return NextResponse.json({ error: `Employee code "${empCode}" is already in use` }, { status: 409 })

  // Check duplicate fingerprint_employee_code
  if (fpCode) {
    const { data: dupFp } = await svc
      .from('users').select('id').eq('fingerprint_employee_code', fpCode).maybeSingle()
    if (dupFp) return NextResponse.json({ error: `Fingerprint code "${fpCode}" is already assigned to another employee` }, { status: 409 })
  }

  // Placeholder email: attendance-only employees won't log in
  const emailSlug = empCode.toLowerCase().replace(/[^a-z0-9]/g, '')
  const email = `${emailSlug}@attendance.local`

  // Check if placeholder email already taken (edge case)
  const { data: dupEmail } = await svc
    .from('users').select('id').eq('email', email).maybeSingle()
  const finalEmail = dupEmail ? `${emailSlug}.${Date.now()}@attendance.local` : email

  // Create auth user (attendance-only — random password, no email confirm needed)
  const { data: authData, error: authCreateErr } = await svc.auth.admin.createUser({
    email: finalEmail,
    password: crypto.randomUUID(),
    email_confirm: true,
  })
  if (authCreateErr || !authData.user) {
    return NextResponse.json({ error: authCreateErr?.message ?? 'Failed to create auth user' }, { status: 500 })
  }

  // Insert into public.users
  const { error: dbErr } = await svc.from('users').insert({
    id:                        authData.user.id,
    full_name:                 full_name.trim(),
    email:                     finalEmail,
    phone:                     null,
    role:                      'member',
    team:                      team?.trim() || null,
    position:                  null,
    is_active:                 true,
    employee_code:             empCode,
    fingerprint_employee_code: fpCode,
  })

  if (dbErr) {
    // Clean up orphaned auth user on DB insert failure
    await svc.auth.admin.deleteUser(authData.user.id)
    return NextResponse.json({ error: dbErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, id: authData.user.id })
}
