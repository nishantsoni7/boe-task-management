/**
 * GET /api/task-detail?taskId=<uuid>
 *
 * Returns creator name + recent activity for a single task.
 * Admin/manager only. Uses service role to bypass RLS.
 */

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function GET(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const client = sb()

  const { data: { user }, error: authErr } = await client.auth.getUser(token)
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: caller } = await client
    .from('users').select('role').eq('id', user.id).single()
  if (!caller || !['admin', 'manager'].includes(caller.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const taskId = req.nextUrl.searchParams.get('taskId')
  if (!taskId) return NextResponse.json({ error: 'taskId required' }, { status: 400 })

  // Fetch task row (created_by) + activity log in parallel
  const [{ data: taskRow }, { data: activityRows }] = await Promise.all([
    client.from('tasks').select('created_by').eq('id', taskId).single(),
    client.from('task_activity_log')
      .select('action, note, from_status, to_status, old_val, new_val, created_at, actor_id')
      .eq('task_id', taskId)
      .order('created_at', { ascending: false })
      .limit(8),
  ])

  // Collect all user IDs to resolve names in one query
  const actorIds = [...new Set([
    ...(activityRows ?? []).map((a: { actor_id: string }) => a.actor_id),
    ...(taskRow?.created_by ? [taskRow.created_by] : []),
  ])]

  let nameMap: Record<string, string> = {}
  if (actorIds.length > 0) {
    const { data: users } = await client
      .from('users').select('id, full_name').in('id', actorIds)
    if (users) for (const u of users) nameMap[u.id] = u.full_name
  }

  return NextResponse.json({
    created_by_name: taskRow?.created_by ? (nameMap[taskRow.created_by] ?? null) : null,
    activity: (activityRows ?? []).map((a: {
      action: string; note: string | null
      from_status: string | null; to_status: string | null
      old_val: string | null; new_val: string | null
      created_at: string; actor_id: string
    }) => ({
      action:      a.action,
      note:        a.note,
      from_status: a.from_status,
      to_status:   a.to_status,
      old_val:     a.old_val,
      new_val:     a.new_val,
      created_at:  a.created_at,
      actor_name:  nameMap[a.actor_id] ?? null,
    })),
  })
}
