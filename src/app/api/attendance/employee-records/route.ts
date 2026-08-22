import { NextRequest, NextResponse } from 'next/server'
import { requireSelfOrAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { PagedReadError, fetchAllRows, unwrapPagedRows } from '@/lib/supabasePaging'

/** One attendance row, as the employee detail page reads it. */
type EmployeeAttendanceRow = {
  id: string
  attendance_date: string
  check_in_at: string | null
  check_out_at: string | null
  status: string | null
}

// Returns EVERY attendance record for one employee, read in pages.
// Used by the employee detail page for summary card computation.
//
// "ALL RECORDS" MEANT AT MOST 1000. One employee accrues one row per working
// day, so this passes a thousand after roughly three years and PostgREST then
// caps the response with no error and no warning
// (src/lib/supabasePaging.ts). The summary cards computed from these rows would
// silently start describing only the recent past while presenting themselves as
// the employee's whole history.
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

  const auth = await requireSelfOrAdmin(req, requested)
  if (isResponse(auth)) return auth
  const { caller, employeeId } = auth

  // The id tiebreak is required for stable paging: range() maps to LIMIT/OFFSET,
  // which promises nothing about row order unless the ordering is unique.
  try {
    const records = unwrapPagedRows('employee attendance', await fetchAllRows<EmployeeAttendanceRow>(
      (pageFrom, pageTo) => caller.svc
        .from('attendance_records')
        .select('id, attendance_date, check_in_at, check_out_at, status')
        .eq('user_id', employeeId)
        .order('attendance_date', { ascending: false })
        .order('id', { ascending: false })
        .range(pageFrom, pageTo)))

    return NextResponse.json({ records })
  } catch (err) {
    // REFUSE rather than return a partial history. Summary cards built from part
    // of an employee's record look exactly like ones built from all of it.
    const detail = err instanceof PagedReadError ? err.detail : String(err)
    return NextResponse.json({ error: detail }, { status: 500 })
  }
}
