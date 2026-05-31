import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { taskId } = await req.json()
  if (!taskId) {
    return NextResponse.json({ error: 'taskId is required' }, { status: 400 })
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: task, error: fetchErr } = await supabase
    .from('tasks')
    .select('id, status, assigned_to, created_by')
    .eq('id', taskId)
    .single()

  if (fetchErr || !task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  if (task.status !== 'completed') {
    return NextResponse.json({ error: 'Only completed tasks can be restored' }, { status: 400 })
  }

  const isAssignee = task.assigned_to === user.id
  const isCreator  = task.created_by  === user.id
  if (!isAssignee && !isCreator) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const now = new Date().toISOString()

  const { error: updateErr } = await supabase
    .from('tasks')
    .update({ status: 'pending', last_update_at: now })
    .eq('id', taskId)

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  await supabase.from('task_activity_log').insert({
    task_id:     taskId,
    actor_id:    user.id,
    action:      'status_changed',
    from_status: 'completed',
    to_status:   'pending',
    note:        'Restored to In Progress',
  })

  return NextResponse.json({ success: true })
}
