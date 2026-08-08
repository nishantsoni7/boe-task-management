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
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { isReviewableStatus } from '@/lib/objections'

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

  return NextResponse.json({ objection: data })
}
