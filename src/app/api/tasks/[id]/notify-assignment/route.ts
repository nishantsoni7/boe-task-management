/**
 * POST /api/tasks/:id/notify-assignment
 *
 * Creates the "New task assigned to you" notification for a task that has just
 * been created. It exists because the browser cannot: a notifications row
 * addressed to somebody else is refused to every client role, so the four
 * task-creation screens were issuing an insert the database always rejected and
 * the assignee was never told. See src/lib/tasks/assignmentNotification.ts.
 *
 * THE TASK ID IS THE ONLY INPUT. It arrives in the path; the body is ignored
 * entirely, so there is nothing for a caller to put in it. Recipient, task
 * title, notification type, body and the push flag are all derived from the
 * stored task row inside createAssignmentNotification.
 *
 * TWO GATES, IN ORDER. This route establishes WHO is calling — from the session
 * cookie, never from the request — and the operation decides whether that
 * person may cause a notification about this task (creator or admin). Only then
 * does the service-role key get used, and only to read one task row, one user
 * role and to write one notification.
 *
 * RETRY-SAFE. Repeated calls for the same task return `skipped_duplicate`
 * rather than writing a second row; the client retries once on a transport
 * failure. The limit of that guarantee is documented on the operation.
 */

import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isValidUUID } from '@/lib/ui'
import {
  createAssignmentNotification,
  supabaseAssignmentStore,
  ASSIGNMENT_OUTCOME_STATUS,
} from '@/lib/tasks/assignmentNotification'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: taskId } = await params

  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Validated before Postgres sees it: a malformed id would otherwise surface
  // as a 22P02 cast error dressed up as a 500 rather than the 400 it is.
  if (!isValidUUID(taskId)) {
    return NextResponse.json({ error: 'Invalid task id' }, { status: 400 })
  }

  const service = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const outcome = await createAssignmentNotification(
    supabaseAssignmentStore(service),
    { taskId, callerId: user.id },
  )

  if (outcome.status === 'error') {
    // Message only — a notification's title and body carry task titles.
    console.error('[notify-assignment] failed:', outcome.message)
    return NextResponse.json(
      { error: 'Could not create the assignment notification', status: outcome.status },
      { status: ASSIGNMENT_OUTCOME_STATUS.error },
    )
  }

  if (outcome.status === 'not_found') {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  if (outcome.status === 'forbidden') {
    return NextResponse.json(
      { error: 'You cannot create a notification for this task' },
      { status: 403 },
    )
  }

  // created / skipped_self / skipped_duplicate — all successes. The status is
  // returned so a caller can tell "notified" from "nobody to notify" without
  // guessing from a 200.
  return NextResponse.json({ status: outcome.status }, { status: 200 })
}
