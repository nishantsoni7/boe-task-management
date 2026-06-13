import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { taskId, reason, actorName } = await req.json()
  if (!taskId)  return NextResponse.json({ error: 'taskId is required' }, { status: 400 })
  if (!reason?.trim()) return NextResponse.json({ error: 'Cancellation reason is required' }, { status: 400 })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: task, error: fetchErr } = await supabase
    .from('tasks')
    .select('id, title, status, assigned_to, created_by')
    .eq('id', taskId)
    .single()

  if (fetchErr || !task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  if (task.status === 'completed' || task.status === 'cancelled') {
    return NextResponse.json({ error: 'Task is already completed or cancelled' }, { status: 400 })
  }

  // Authorization: creator OR admin only. Assignee cannot cancel unless they are also creator/admin.
  const { data: callerProfile } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  const isCreator = task.created_by === user.id
  const isAdmin   = callerProfile?.role === 'admin'

  if (!isCreator && !isAdmin) {
    return NextResponse.json({ error: 'Only the task creator or an admin can cancel a task' }, { status: 403 })
  }

  const now = new Date().toISOString()
  const previousStatus = task.status

  const { error: updateErr } = await supabase
    .from('tasks')
    .update({
      status:              'cancelled',
      cancelled_by:        user.id,
      cancelled_at:        now,
      cancellation_reason: reason.trim(),
      last_update_at:      now,
    })
    .eq('id', taskId)

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  await supabase.from('task_activity_log').insert({
    task_id:     taskId,
    actor_id:    user.id,
    action:      'status_changed',
    from_status: previousStatus,
    to_status:   'cancelled',
    note:        reason.trim(),
  })

  // Notify assignee (if different from the actor)
  if (task.assigned_to && task.assigned_to !== user.id) {
    const actor = typeof actorName === 'string' && actorName.trim() ? actorName.trim() : null
    const title = actor ? `${actor} cancelled a task` : 'Task cancelled'
    await supabase.from('notifications').insert({
      user_id:      task.assigned_to,
      task_id:      taskId,
      type:         'task_acknowledged',
      title,
      body:         task.title,
      is_push_sent: true,
    })
  }

  return NextResponse.json({ success: true })
}
