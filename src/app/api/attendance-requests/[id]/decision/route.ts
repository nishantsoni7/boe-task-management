// POST /api/attendance-requests/[id]/decision     admin approves or rejects
//
// Body: { status: 'approved' | 'rejected', note?: string }
//
// Approval records PERMISSION (or acceptance of the explanation). It does not
// decide whether missed time is paid, and it changes no punch, correction,
// deduction or salary — that is the payroll review's job.
//
// Rejection needs a reason; revising an earlier decision needs a reason. The
// update is conditional on the status the admin saw, so two reviewers deciding
// at once cannot both win, and the employee is notified once, only after the
// change committed.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { REQUEST_COLUMNS, validateDecision, type AttendanceRequestRow } from '@/lib/attendance/requests'
import { notifyEmployeeOfDecision, requestDbError } from '@/lib/attendance/requestsServer'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth
  const { id } = await params

  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  const { data } = await auth.svc.from('attendance_requests').select(REQUEST_COLUMNS).eq('id', id).maybeSingle()
  if (!data) return NextResponse.json({ error: 'Request not found.' }, { status: 404 })
  const current = data as unknown as AttendanceRequestRow

  const v = validateDecision(body, current.status)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

  const { data: updated, error } = await auth.svc.from('attendance_requests')
    .update({
      status: v.value.status,
      decided_by: auth.id,
      decided_at: new Date().toISOString(),
      decision_note: v.value.note,
      updated_by: auth.id,
    })
    .eq('id', id)
    .eq('status', current.status)
    .select(REQUEST_COLUMNS)
    .maybeSingle()

  if (error) {
    const mapped = requestDbError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }
  if (!updated) return NextResponse.json({ error: 'This request was changed by someone else a moment ago. Reload.' }, { status: 409 })

  await notifyEmployeeOfDecision(auth.svc, updated as unknown as AttendanceRequestRow)
  return NextResponse.json({ request: updated })
}
