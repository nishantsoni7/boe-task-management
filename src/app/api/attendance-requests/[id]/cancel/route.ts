// POST /api/attendance-requests/[id]/cancel     the employee withdraws their OWN request
//
// A pending request can be withdrawn any time; an approved one only before its
// shift starts (canEmployeeCancel). The row is never deleted — its status
// becomes `cancelled` and the audit trigger records who and when.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller, UNAUTHORIZED } from '@/lib/security/attendancePayrollApiAuth'
import { REQUEST_COLUMNS, canEmployeeCancel, NOTE_MAX_LENGTH, type AttendanceRequestRow } from '@/lib/attendance/requests'
import { requestDbError } from '@/lib/attendance/requestsServer'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()
  const { id } = await params

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, NOTE_MAX_LENGTH) : ''

  const { data } = await caller.svc.from('attendance_requests').select(REQUEST_COLUMNS)
    .eq('id', id).eq('employee_id', caller.id).maybeSingle()
  if (!data) return NextResponse.json({ error: 'Request not found.' }, { status: 404 })
  const row = data as unknown as AttendanceRequestRow

  if (!canEmployeeCancel(row, new Date().toISOString()))
    return NextResponse.json({ error: 'This request can no longer be cancelled. Ask an admin.' }, { status: 409 })

  const { data: updated, error } = await caller.svc.from('attendance_requests')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancel_reason: reason || 'Cancelled by the employee',
      updated_by: caller.id,
    })
    .eq('id', id)
    .eq('status', row.status)   // lost race with a decision → no row, 409 below
    .select(REQUEST_COLUMNS)
    .maybeSingle()

  if (error) {
    const mapped = requestDbError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }
  if (!updated) return NextResponse.json({ error: 'This request changed a moment ago. Reload and try again.' }, { status: 409 })
  return NextResponse.json({ request: updated })
}
