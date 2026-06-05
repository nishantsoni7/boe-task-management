import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  // Verify caller is authenticated
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { taskId, taskTitle, createdBy, title: notifTitle } = await req.json()
  if (!taskId || !taskTitle || !createdBy) {
    return NextResponse.json({ error: 'taskId, taskTitle, and createdBy are required' }, { status: 400 })
  }

  // Skip notification when the assignee is the same person as the creator
  if (createdBy === user.id) {
    return NextResponse.json({ skipped: true })
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { error } = await supabase.from('notifications').insert({
    user_id:      createdBy,
    task_id:      taskId,
    type:         'task_acknowledged',
    title:        notifTitle ?? 'Task status updated',
    body:         taskTitle,
    is_push_sent: true,
  })

  if (error) {
    console.error('[notify-status-update] notification insert failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
