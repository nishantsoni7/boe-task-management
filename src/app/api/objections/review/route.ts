// POST /api/objections/review    admin marks an objection resolved or rejected
//
// This changes the OBJECTION and nothing else. It cannot touch a punch, a
// classification, a deduction, a salary or an adjustment — if the employee was
// right, the admin still makes the actual correction through the existing
// attendance correction workflow, which keeps its own audit trail.
//
// The admin check is asserted twice on purpose: here, so the route answers 403
// rather than surfacing a Postgres error, and again inside
// review_employee_record_objection(), which is SECURITY DEFINER and must not
// depend on its caller having checked anything.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse, type ServiceClient } from '@/lib/security/attendancePayrollApiAuth'
import { isReviewableStatus, issueSubjectLabel, type ObjectionRow } from '@/lib/objections'

/**
 * An anon client carrying the caller's own token, so `auth.uid()` resolves
 * inside the function.
 *
 * The service-role client cannot be used here: it has no auth.uid(), and
 * review_employee_record_objection() derives the reviewer from it. That is the
 * right way round — the function decides who reviewed, rather than trusting an
 * id supplied by whatever called it — but it means the call has to be made AS
 * the admin, not as the service role.
 */
function callerClient(req: NextRequest) {
  const authorization = req.headers.get('authorization') ?? ''
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { authorization } },
    },
  )
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth

  const body = await req.json().catch(() => ({}))
  const objectionId = typeof body.objection_id === 'string' ? body.objection_id.trim() : ''
  const status      = body.status
  const note        = typeof body.review_note === 'string' ? body.review_note.trim() : null

  if (!objectionId) {
    return NextResponse.json({ error: 'objection_id is required' }, { status: 400 })
  }
  if (!isReviewableStatus(status)) {
    return NextResponse.json({ error: 'status must be approved or rejected' }, { status: 400 })
  }

  const { data, error } = await callerClient(req).rpc('review_employee_record_objection', {
    p_objection_id: objectionId,
    p_status:       status,
    p_review_note:  note,
  })

  if (error) {
    // The function raises named errors; map the two an admin can actually hit.
    if (error.message.includes('OBJECTION_NOT_FOUND')) {
      return NextResponse.json({ error: 'That objection no longer exists.' }, { status: 404 })
    }
    if (error.message.includes('OBJECTION_ALREADY_REVIEWED')) {
      return NextResponse.json({ error: 'That objection has already been reviewed.' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Tell the employee. Reached only past the error branch above, so a
  // notification cannot exist for a status change that did not happen — and
  // because the RPC refuses anything that is not still `pending`, a second POST
  // for the same objection stops at the 409 above and never notifies twice.
  //
  // Awaited so a failure is logged rather than lost in an unhandled rejection,
  // but never allowed to fail the review: the decision is already committed,
  // and reporting a notification problem as a failed review would invite an
  // admin to press Resolve again.
  await notifyEmployeeOfDecision(auth.svc, data as ObjectionRow | null)

  return NextResponse.json({ objection: data })
}

/**
 * One notification, to the one person waiting for it.
 *
 * The recipient is read from the REVIEWED ROW the function returned, not from
 * anything the request carried — so the notification cannot be addressed
 * anywhere other than the employee whose objection was actually changed.
 *
 * `entity_id` carries the objection id, which getNotificationMeta() turns into
 * /my-issues?issue=… — a filter over rows the employee already owns, never a
 * route assembled from a caller-supplied id.
 *
 * REQUIRES 20260825000000_objection_review_notification_types.sql. Until that
 * is applied the insert fails the enum check and is logged here; the review
 * itself is unaffected.
 */
async function notifyEmployeeOfDecision(
  svc: ServiceClient,
  row: ObjectionRow | null,
): Promise<void> {
  if (!row?.employee_id) return

  try {
    const isAttendance = !!row.attendance_date
    const outcome  = row.status === 'approved' ? 'resolved' : 'rejected'
    const subject  = issueSubjectLabel(row)
    const what     = isAttendance ? 'attendance issue' : 'payroll issue'

    const { error } = await svc.from('notifications').insert({
      user_id:   row.employee_id,
      type:      isAttendance ? 'attendance_issue_reviewed' : 'payroll_issue_reviewed',
      title:     `Your ${what} for ${subject} was ${outcome}`,
      body:      row.review_note?.trim()
        ? row.review_note.trim()
        : 'Open the issue to read the full history.',
      entity_id: row.id,
    })

    if (error) {
      console.error('[objections] decision not delivered:', error.message)
    }
  } catch (e) {
    console.error('[objections] decision notification failed:', e)
  }
}
