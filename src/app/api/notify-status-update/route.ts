import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { insertUserNotifications } from '@/lib/notificationWrites'
import { loadActivityEvent, verifyActivityBelongsToTask } from '@/lib/notifications/activityLink'
import { deriveNoticeFromEvent } from '@/lib/notifications/statusEventNotice'
import { shouldNotifyTaskStatusEvent } from '@/lib/notifications/taskNotificationPolicy'
import { isValidUUID } from '@/lib/ui'

export async function POST(req: NextRequest) {
  // Verify caller is authenticated
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // WHAT THE BROWSER IS STILL ALLOWED TO SAY.
  //
  // Only WHICH task, WHICH event, WHICH activity row, and WHO to tell — and
  // NONE of it is acted on until the caller has been shown to be a party to
  // the task and the recipient to be the other one. Everything the
  // notification asserts as fact (the task's name, the actor's name, the
  // headline) is read from the database below.
  //
  // WHAT WAS REMOVED, AND WHY. This route used to take `title`, `taskTitle`
  // and `actorName` from the request body and store them verbatim. `title`
  // bypassed composeTitle entirely, so any authenticated user could POST a
  // notification to anybody with a headline and body of their choosing —
  // including one that named somebody else as the actor. No caller ever sent
  // `title`; the other two always sent exactly what the task row already says.
  // So nothing legitimate is lost by refusing to listen.
  const {
    taskId, createdBy, recipientId, action: claimedAction,
    // true when the caller is announcing an event it found AFTER a lost response: the event is then REQUIRED, never optional.
    recovery,
    // The activity row the caller just created. VERIFIED below, never trusted:
    // an unchecked id here would let a caller point a notification at any
    // activity row in the database and have its note read back to the
    // recipient. See src/lib/notifications/activityLink.ts.
    activityLogId,
  } = await req.json()
  if (!taskId || !isValidUUID(taskId)) {
    return NextResponse.json({ error: 'A valid taskId is required' }, { status: 400 })
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // The two facts the notification states, both read rather than accepted. One
  // round trip: neither needs the other's result.
  //
  // ONE COLUMN ABOUT THE ACTOR — their display name, which the recipient
  // already sees on the task itself. Never `select('*')` on users: several of
  // its columns are column-granted and reading them is a 42501.
  const [taskRes, actorRes] = await Promise.all([
    supabase.from('tasks').select('created_by, assigned_to, title, task_type').eq('id', taskId).maybeSingle(),
    supabase.from('users').select('full_name').eq('id', user.id).maybeSingle(),
  ])
  const task = taskRes.data as {
    created_by: string | null; assigned_to: string | null; title: string | null; task_type: string | null
  } | null
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  // THE CALLER MUST BE A PARTY TO THE TASK, TOO.
  //
  // Checked before anything the caller asked for is looked at — not the
  // recipient, not the action. Being signed in is not a licence to cause a
  // notification about somebody else's task: without this, any authenticated
  // user could pick a task id they have no relationship to and make its
  // creator and assignee tell each other whatever the action vocabulary allows.
  //
  // THIS MIRRORS A GATE THE CLIENT ALREADY APPLIES. canPostUpdate() is
  // `(isAssignee || isCreator) && !isFinished`, with NO admin exception, and
  // every other entry point to this route is assignee-only. So no legitimate
  // caller — an admin included — can reach this branch, and no call site needs
  // to change. See src/lib/tasks/taskDetailAccess.ts.
  //
  // THE RESPONSE SAYS NOTHING ABOUT THE TASK. Not its title, not who owns it,
  // not whether it exists — a refusal that leaks any of those turns this route
  // into a lookup oracle for task ids. The detail goes to the log instead.
  const callerIsParticipant =
    user.id === task.created_by || user.id === task.assigned_to
  if (!callerIsParticipant) {
    console.error('[notify-status-update] caller is not a party to the task', {
      caller: user.id, taskId,
    })
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // recipientId is the explicit target; fall back to createdBy for legacy callers
  const notifyUserId = recipientId ?? createdBy
  if (!notifyUserId) {
    return NextResponse.json({ error: 'recipientId is required' }, { status: 400 })
  }

  // Skip notification when actor and recipient are the same person
  if (notifyUserId === user.id) {
    return NextResponse.json({ skipped: true })
  }

  // THE RECIPIENT MUST BE A PARTY TO THE TASK.
  //
  // Both sides are read from the stored row, so a caller cannot name a
  // recipient by supplying one. Every real call site already derives its
  // recipient as `created_by` or `assigned_to` — this refuses what none of them
  // can produce, which is why it is a hard 403 rather than a silent skip: it is
  // reachable only by an attack or by a genuine bug, and both are worth seeing.
  if (notifyUserId !== task.created_by && notifyUserId !== task.assigned_to) {
    console.error('[notify-status-update] recipient not a party to the task', {
      caller: user.id, taskId,
    })
    return NextResponse.json({ error: 'Invalid recipient' }, { status: 403 })
  }

  // THE EVENT, WHEN THE CALLER NAMES ONE, IS THE SOURCE OF THE FACTS.
  //
  // A status change leaves a history row. When the caller names that row, the action is READ from it and the recipient and the
  // type are checked against it and the stored task: the event must be a status change, on this task, authored by the caller,
  // and the action and recipient the request claims must be the ones it implies. A disagreement is refused (422), never
  // silently overridden. See src/lib/notifications/statusEventNotice.ts. This sits after both party checks above, so a refusal
  // still reads as one, and before the notification policy and the write.
  //
  // A `recovery` send (the page found its event after a lost response) REQUIRES such an event: with none, nothing is written, so
  // a recovery can never degrade into an unlinked notice that the event key cannot protect.
  //
  // Matching an event is not proof that THIS request wrote it (a second tab of the same person leaves an identical row), so
  // nothing here, or in what is returned, says "confirmed".
  const eventRow = typeof activityLogId === 'string' && isValidUUID(activityLogId)
    ? await loadActivityEvent(supabase, activityLogId, taskId)
    : null
  const isStatusEvent = !!eventRow && eventRow.action === 'status_changed'
  if (recovery === true && !isStatusEvent) {
    return NextResponse.json({ error: 'No matching event for this notification', reason: 'event_required' }, { status: 422 })
  }
  const derived = isStatusEvent && eventRow
    ? deriveNoticeFromEvent(
        eventRow,
        { id: taskId, created_by: task.created_by, assigned_to: task.assigned_to },
        user.id,
        { action: claimedAction, recipientId: notifyUserId },
      )
    : null
  if (derived && !derived.ok) {
    console.error('[notify-status-update] event does not match the notification', { caller: user.id, taskId, reason: derived.reason })
    return NextResponse.json({ error: 'The event does not match this notification', reason: derived.reason }, { status: 422 })
  }
  // From here on `action` is the EVENT's status when there is a status event, the caller's word otherwise (legacy callers).
  const action: string | undefined = derived?.ok ? derived.action : claimedAction

  // NOT ANNOUNCED, BY RULE — after both party checks, so a refusal still reads
  // as one. A quotation request writes no notification, and a delegated task's
  // "completed" is its creator's approval arriving by this generic road. See
  // src/lib/notifications/taskNotificationPolicy.ts.
  if (!shouldNotifyTaskStatusEvent(task, action)) {
    return NextResponse.json({ success: true, skipped: true })
  }

  // Composed here, from the action and the actor resolved by `auth.uid()`.
  // A caller can no longer choose the sentence, nor sign it with someone
  // else's name. An unresolved name is normal — composeTitle has actor-less
  // phrasing for every action it knows.
  const actorName = (actorRes.data as { full_name?: string | null } | null)?.full_name
  const title = composeTitle(action, actorName ?? undefined)

  // The link is optional at every step: an absent, malformed or unrelated id
  // produces an UNLINKED notification, which renders exactly the fallbacks
  // every historical row renders. A worse notification, never a failed one.
  const linkedActivityId = eventRow
    ? eventRow.id
    : typeof activityLogId === 'string' && isValidUUID(activityLogId)
      ? await verifyActivityBelongsToTask(supabase, activityLogId, taskId)
      : null

  // Every event this route serves is a person acting on a task, so nothing it
  // builds is ever suppressed. It goes through the shared guard anyway: this is
  // the funnel EVERY task status notification passes through, which makes it
  // the one place a system-generated type could ever reach `notifications`
  // from application code. See src/lib/notificationWrites.ts.
  const { suppressed, selfSuppressed, duplicate, error } = await insertUserNotifications(supabase, {
    user_id:      notifyUserId,
    task_id:      taskId,
    type:         'task_acknowledged',
    title,
    // The task's OWN name, not the caller's word for it.
    body:         task.title ?? '',
    is_push_sent: true,
    activity_log_id: linkedActivityId,
  }, { actorId: user.id })

  if (error) {
    console.error('[notify-status-update] notification insert failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // This event was already announced to this person (a repeat of the same send — a recovery, a second tab). Success: they
  // have their notification, and the database, not a racing read, is what said so.
  if (duplicate) return NextResponse.json({ success: true, skipped: true, duplicate: true })
  if (suppressed > 0) return NextResponse.json({ success: true, suppressed })
  // Nothing was wrong: the actor is the recipient, so there was nobody to tell.
  // Reported the same way the early `notifyUserId === user.id` return is.
  if (selfSuppressed > 0) return NextResponse.json({ success: true, skipped: true })
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
