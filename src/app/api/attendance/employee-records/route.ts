import { NextRequest, NextResponse } from 'next/server'
import { requireSelfOrModuleAccess, isResponse } from '@/lib/security/attendancePayrollApiAuth'

// Returns all attendance records for one employee (unpaginated).
// Used by the employee detail page for summary card computation.
//
// Runs on the service role, so RLS is not the boundary here — the identity
// check is. `employee_id` used to be taken straight from the query string with
// no check at all, which made this route a full read of any employee's
// attendance for anyone holding a valid token. It is now authorised first, and
// the query is constrained to the id that survived that check, never the raw
// parameter.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const requested = searchParams.get('employee_id')

  const auth = await requireSelfOrModuleAccess(req, 'attendance', requested)
  if (isResponse(auth)) return auth
  const { caller, employeeId } = auth

  const { data, error } = await caller.svc
    .from('attendance_records')
    .select('id, attendance_date, check_in_at, check_out_at, status')
    .eq('user_id', employeeId)
    .order('attendance_date', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ records: data ?? [] })
}
