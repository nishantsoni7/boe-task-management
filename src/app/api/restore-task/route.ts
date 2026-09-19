import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { insertUserNotifications } from '@/lib/notificationWrites'
import { restoreTargetStatus } from '@/lib/tasks/reviewTransitions'

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { taskId, actorName } = await req.json()
  if (!taskId) {
    return NextResponse.json({ error: 'taskId is required' }, { status: 400 })
  }

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

  const isRestorable = task.status === 'completed' || task.status === 'cancelled'
  if (!isRestorable) {
    return NextResponse.json({ error: 'Only completed or cancelled tasks can be restored' }, { status: 400 })
  }

  const isAssignee = task.assigned_to === user.id
  const isCreator  = task.created_by  === user.id

  // Fetch caller role — admins can restore any task
  const { data: callerProfile } = await supabase
    .from('users').select('role').eq('id', user.id).single()
  const isAdmin = callerProfile?.role === 'admin'

  if (!isAssignee && !isCreator && !isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const terminalStatus = task.status // 'completed' or 'cancelled'

  const { data: terminalLog } = await supabase
    .from('task_activity_log')
    .select('from_status')
    .eq('task_id', taskId)
    .eq('to_status', terminalStatus)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  // A task closed by creator approval was in `pending_approval` immediately
  // before it completed, and restoring it there would put it back in the
  // creator's queue with nothing for the assignee to do. It goes to `working`
  // instead — see restoreTargetStatus for the reasoning.
  const restoreStatus = restoreTargetStatus(terminalLog?.from_status)

  const now = new Date().toISOString()

  const taskUpdates: Record<string, unknown> = {
    status:        restoreStatus,
    last_update_at: now,
  }
  if (terminalStatus === 'completed') taskUpdates.completed_at = null
  if (terminalStatus === 'cancelled') {
    taskUpdates.cancelled_by        = null
    taskUpdates.cancelled_at        = null
    taskUpdates.cancellation_reason = null
  }

  const { error: updateErr } = await supabase
    .from('tasks')
    .update(taskUpdates)
    .eq('id', taskId)

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  // Read the id back so the notification can point at THIS row. A failed read
  // leaves the link null; the restore has already happened and is not undone.
  const { data: restoreLog } = await supabase
    .from('task_activity_log')
    .insert({
      task_id:     taskId,
      actor_id:    user.id,
      action:      'status_changed',
      from_status: terminalStatus,
      to_status:   restoreStatus,
      note:        terminalStatus === 'cancelled' ? 'Cancellation reversed' : 'Reopened task',
    })
    .select('id')
    .single()

  // Notify the other party
  const recipient = user.id === task.created_by ? task.assigned_to : task.created_by
  if (recipient && recipient !== user.id) {
    const actor = typeof actorName === 'string' && actorName.trim()
      ? actorName.trim()
      : null
    const verb  = terminalStatus === 'cancelled' ? 'reversed cancellation of' : 'reopened'
    const title = actor ? `${actor} ${verb} a task` : terminalStatus === 'cancelled' ? 'Task cancellation reversed' : 'Task reopened'
    await insertUserNotifications(supabase, {
      user_id:      recipient,
      task_id:      taskId,
      type:         'task_acknowledged',
      title,
      body:         task.title,
      is_push_sent: true,
      activity_log_id: restoreLog?.id ?? null,
    }, { actorId: user.id })
  }

  return NextResponse.json({ success: true, restoredStatus: restoreStatus })
}
