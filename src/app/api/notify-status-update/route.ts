import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { insertUserNotifications } from '@/lib/notificationWrites'
import { verifyActivityBelongsToTask } from '@/lib/notifications/activityLink'
import { isValidUUID } from '@/lib/ui'

export async function POST(req: NextRequest) {
  // Verify caller is authenticated
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const {
    taskId, taskTitle, createdBy, recipientId, title: notifTitle, action, actorName,
    // The activity row the caller just created. VERIFIED below, never trusted:
    // an unchecked id here would let a caller point a notification at any
    // activity row in the database and have its note read back to the
    // recipient. See src/lib/notifications/activityLink.ts.
    activityLogId,
  } = await req.json()
  if (!taskId || !taskTitle || !createdBy) {
    return NextResponse.json({ error: 'taskId, taskTitle, and createdBy are required' }, { status: 400 })
  }

  // recipientId is the explicit target; fall back to createdBy for legacy callers
  const notifyUserId = recipientId ?? createdBy

  // Skip notification when actor and recipient are the same person
  if (notifyUserId === user.id) {
    return NextResponse.json({ skipped: true })
  }

  // Compose a clear, human-readable title.
  // Precedence: an explicit `title` (legacy callers) wins; otherwise derive
  // from `action` (the new status / "acknowledged") and the actor's name.
  const title = notifTitle ?? composeTitle(action, actorName)

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // The link is optional at every step: an absent, malformed or unrelated id
  // produces an UNLINKED notification, which renders exactly the fallbacks
  // every historical row renders. A worse notification, never a failed one.
  const linkedActivityId =
    typeof activityLogId === 'string' && isValidUUID(activityLogId)
      ? await verifyActivityBelongsToTask(supabase, activityLogId, taskId)
      : null

  // Every event this route serves is a person acting on a task, so nothing it
  // builds is ever suppressed. It goes through the shared guard anyway: this is
  // the funnel EVERY task status notification passes through, which makes it
  // the one place a system-generated type could ever reach `notifications`
  // from application code. See src/lib/notificationWrites.ts.
  const { suppressed, error } = await insertUserNotifications(supabase, {
    user_id:      notifyUserId,
    task_id:      taskId,
    type:         'task_acknowledged',
    title,
    body:         taskTitle,
    is_push_sent: true,
    activity_log_id: linkedActivityId,
  })

  if (error) {
    console.error('[notify-status-update] notification insert failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (suppressed > 0) return NextResponse.json({ success: true, suppressed })
  return NextResponse.json({ success: true })
}

// Build the notification headline from the action and (optionally) the actor.
// Examples: "Nishant moved task to Waiting", "Nishant completed task".
// Falls back to actor-less phrasing, then a generic line, when data is missing.
function composeTitle(action?: string, actorName?: string): string {
  const actor = typeof actorName === 'string' ? actorName.trim() : ''
  switch (action) {
    case 'acknowledged':
      return actor ? `${actor} acknowledged task` : 'Task acknowledged'
    case 'comment_added':
      return actor ? `${actor} added a comment` : 'New comment on task'
    case 'completed':
      return actor ? `${actor} completed task` : 'Task completed'
    case 'cancelled':
      return actor ? `${actor} cancelled task` : 'Task cancelled'
    case 'waiting':
    case 'blocked':
    case 'working':
    case 'started':
    case 'pending': {
      const label = action.charAt(0).toUpperCase() + action.slice(1)
      return actor ? `${actor} moved task to ${label}` : `Task moved to ${label}`
    }
    default:
      return 'Task status updated'
  }
}
