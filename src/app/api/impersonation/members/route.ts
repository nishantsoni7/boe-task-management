// GET /api/impersonation/members
//
// Every member an administrator may sign in as — no filter on role, team or
// status (inactive members are listed and flagged). Admin-only, verified from
// the bearer token. Explicit field list: a column added to public.users later
// cannot leak through here.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth

  const { data, error } = await auth.svc
    .from('users')
    .select('id, full_name, email, role, team, position, designation_level, is_active, employee_code')
    .neq('is_deleted', true)
    .order('full_name')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ members: data ?? [] })
}
