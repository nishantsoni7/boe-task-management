// GET /api/attendance-requests/[id]/history     the audit trail of one request chain
//
// A correction is a new row pointing at the one it replaced, so "the history
// of this request" is the chain back to the first submission. The employee may
// read their own chain; an admin any. The events were written by trigger in the
// same statement as each change, so they cannot disagree with the rows.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller, UNAUTHORIZED } from '@/lib/security/attendancePayrollApiAuth'

const MAX_CHAIN = 20

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()
  const { id } = await params

  const ids: string[] = []
  let cursor: string | null = id
  let owner: string | null = null
  while (cursor && ids.length < MAX_CHAIN) {
    const res = await caller.svc.from('attendance_requests')
      .select('id, employee_id, replaces_request_id').eq('id', cursor).maybeSingle()
    const row = res.data as { id: string; employee_id: string; replaces_request_id: string | null } | null
    if (!row) break
    owner ??= row.employee_id
    ids.push(row.id)
    cursor = row.replaces_request_id
  }
  // Same 404 for "not yours" and "does not exist".
  if (!owner || (!caller.isAdmin && owner !== caller.id))
    return NextResponse.json({ error: 'Request not found.' }, { status: 404 })

  const { data, error } = await caller.svc.from('attendance_request_events')
    .select('id, request_id, action, status_from, status_to, note, created_at, actor:users!attendance_request_events_actor_id_fkey ( full_name )')
    .in('request_id', ids)
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ events: data ?? [] })
}
