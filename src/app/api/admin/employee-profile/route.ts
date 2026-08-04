// GET /api/admin/employee-profile?employee_id=...
//
// The one server path that hands another employee's Admin-only HR fields to a
// browser. It exists because `monthly_salary` and `payroll_notes` are no longer
// selectable by `authenticated` (migration 20260813000000), and the attendance
// Employee Detail screen legitimately shows them to an admin.
//
// Two rules it exists to keep:
//   * Admin is verified server-side, from the bearer token, before any read.
//   * The response is an explicit field list, not a serialized users row — so a
//     column added to public.users later cannot start leaking through here.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth

  const employeeId = req.nextUrl.searchParams.get('employee_id')
  if (!employeeId) {
    return NextResponse.json({ error: 'employee_id is required' }, { status: 400 })
  }

  const { data, error } = await auth.svc
    .from('users')
    .select('id, full_name, team, position, role, employee_code, fingerprint_employee_code, is_active, joining_date, monthly_salary, payroll_active, employment_type, payroll_notes')
    .eq('id', employeeId)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data)  return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({
    employee: {
      id:                        data.id,
      full_name:                 data.full_name,
      team:                      data.team,
      position:                  data.position,
      role:                      data.role,
      employee_code:             data.employee_code,
      fingerprint_employee_code: data.fingerprint_employee_code,
      is_active:                 data.is_active,
      joining_date:              data.joining_date,
      monthly_salary:            data.monthly_salary,
      payroll_active:            data.payroll_active,
      employment_type:           data.employment_type,
      payroll_notes:             data.payroll_notes,
    },
  })
}
