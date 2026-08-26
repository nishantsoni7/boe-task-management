/**
 * POST /api/tasks/[id]/copy — admin-only "Copy & Assign".
 *
 * Creates an independent new task that copies only the source's title,
 * description, priority and task-level attachments. Due date, assignee and
 * priority come from the request; status starts pending / unacknowledged.
 * The source task is never modified.
 *
 * Authorization is enforced here (not just in the UI): the caller must be an
 * authenticated, active admin. Task + attachment rows are the required writes —
 * if attachment copying fails the new task is rolled back so no half-copied
 * task is left behind. Shared storage objects are never uploaded or removed.
 */

import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { insertUserNotifications } from '@/lib/notificationWrites'
import { resolveAttachmentPath, canonicalAttachmentRef } from '@/lib/tasks/attachmentStorage'

const VALID_PRIORITIES = ['high', 'medium', 'low'] as const

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sourceTaskId } = await params

  // 1. Authenticate via the cookie session.
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Please sign in and try again.' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  const { assigneeId, dueDate, priority, description } = body as {
    assigneeId?: string; dueDate?: string; priority?: string; description?: unknown
  }

  const supabase = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // 2. Authorize: the caller must exist, be active, and be an admin.
  const { data: caller } = await supabase
    .from('users')
    .select('role, is_active, team')
    .eq('id', user.id)
    .single()
  if (!caller || !caller.is_active) {
    return NextResponse.json({ error: 'Your account is not active.' }, { status: 403 })
  }
  if (caller.role !== 'admin') {
    return NextResponse.json({ error: 'Only an admin can copy a task.' }, { status: 403 })
  }

  // 3. Validate inputs.
  if (!assigneeId) return NextResponse.json({ error: 'Please choose an assignee.' }, { status: 400 })
  if (!dueDate || Number.isNaN(Date.parse(dueDate))) {
    return NextResponse.json({ error: 'Please choose a valid due date.' }, { status: 400 })
  }
  if (!priority || !(VALID_PRIORITIES as readonly string[]).includes(priority)) {
    return NextResponse.json({ error: 'Please choose a valid priority.' }, { status: 400 })
  }
  // description is optional, but when present it must be a plain string — reject arrays,
  // objects, numbers, or null so the client can't smuggle unexpected shapes into the note.
  if (description !== undefined && typeof description !== 'string') {
    return NextResponse.json({ error: 'Invalid description.' }, { status: 400 })
  }

  // 4. Source task must exist. Quotation requests are not copyable.
  const { data: source, error: srcErr } = await supabase
    .from('tasks')
    .select('id, title, note, type, team, task_type, attachment_url, attachment_storage_path')
    .eq('id', sourceTaskId)
    .single()
  if (srcErr || !source) return NextResponse.json({ error: 'Source task not found.' }, { status: 404 })
  if (source.task_type === 'quotation_request') {
    return NextResponse.json({ error: 'Quotation requests cannot be copied.' }, { status: 400 })
  }

  // 5. Assignee must exist and be active.
  const { data: assignee } = await supabase
    .from('users')
    .select('id, full_name, is_active')
    .eq('id', assigneeId)
    .single()
  if (!assignee || !assignee.is_active) {
    return NextResponse.json({ error: 'The selected assignee is not available.' }, { status: 400 })
  }

  // 6. Load the source's task-level attachments (activity_log_id is null → task, not a comment).
  const { data: sourceAtts, error: attFetchErr } = await supabase
    .from('task_attachments')
    .select('url, storage_path, file_name, file_type')
    .eq('task_id', sourceTaskId)
    .is('activity_log_id', null)
  if (attFetchErr) {
    console.error('[copy] failed to read source attachments:', attFetchErr.message)
    return NextResponse.json({ error: 'Could not read the source attachments.' }, { status: 500 })
  }

  // The legacy single attachment is carried over only when it is NOT already one
  // of the task_attachments rows — otherwise it would copy as a duplicate.
  //
  // De-duplicated by OBJECT PATH, not by URL: the two columns no longer hold the
  // same shape once new rows carry a canonical reference instead of a public
  // URL, so comparing the raw columns would copy the same file twice.
  const attPaths = new Set(
    (sourceAtts ?? []).map(a => resolveAttachmentPath(a)).filter(Boolean) as string[],
  )
  const legacyPath = resolveAttachmentPath(source)
  const copyLegacy = !!legacyPath && !attPaths.has(legacyPath)

  // Description saved on the copy: the admin's edited value when supplied (trimmed; empty → null,
  // matching normal task creation), otherwise the source's description. Stored only on the new
  // task — the source is never updated.
  const note = typeof description === 'string' ? (description.trim() || null) : source.note

  // 7. Create the copy in the standard delegated-task shape: pending + unacknowledged.
  const { data: newTask, error: taskErr } = await supabase
    .from('tasks')
    .insert({
      title:               source.title,
      note,
      priority,
      type:                source.type,              // structural field; preserved for a valid task
      is_urgent:           false,
      due_date:            dueDate,
      assigned_to:         assigneeId,
      created_by:          user.id,
      team:                caller.team ?? source.team,  // task team follows its creator (as on the create page)
      status:              'pending',
      acknowledged_at:     null,
      // Never a public URL — a canonical reference, with the path as the authority.
      attachment_url:          copyLegacy ? canonicalAttachmentRef(legacyPath!) : null,
      attachment_storage_path: copyLegacy ? legacyPath : null,
      copied_from_task_id: source.id,                // authoritative link back to the source
    })
    .select('id')
    .single()
  if (taskErr || !newTask) {
    console.error('[copy] task insert failed:', taskErr?.message)
    return NextResponse.json({ error: 'Could not create the task. Please try again.' }, { status: 500 })
  }

  // 8. Copy the attachment rows (REQUIRED) by referencing the SAME storage OBJECTS.
  //    Copied tasks intentionally reuse the source's objects — no re-upload, no
  //    storage copy. Nothing public is minted: the copy carries the object path,
  //    and whoever opens it signs that path like any other attachment.
  //    Revisit this assumption if task-attachment storage garbage collection is added.
  if (sourceAtts && sourceAtts.length > 0) {
    const rows = sourceAtts.map(a => {
      const path = resolveAttachmentPath(a)
      return {
        task_id:      newTask.id,
        // `a.url` survives only for a historic row whose path could not be
        // parsed; 20260906000000's assertion makes that state impossible in
        // production, and the column goes away once `url` is dropped.
        url:          path ? canonicalAttachmentRef(path) : a.url,
        storage_path: path,
        file_name:    a.file_name,
        file_type:    a.file_type,
        created_by:   user.id,
      }
    })
    const { error: attErr } = await supabase.from('task_attachments').insert(rows)
    if (attErr) {
      // Roll back so no half-copied task survives. Deleting the task cascades its
      // task_attachments rows (FK on delete cascade). The shared storage objects are
      // never removed here — they still belong to the source task.
      console.error('[copy] attachment copy failed, rolling back new task:', attErr.message)
      await supabase.from('tasks').delete().eq('id', newTask.id)
      return NextResponse.json(
        { error: 'Could not copy the attachments, so the task was not created. Please try again.' },
        { status: 500 },
      )
    }
  }

  // 9. Traceability (best-effort): a neutral system event on each task. copied_from_task_id
  //    is the authoritative relationship; these entries are the human-readable cross-reference.
  const { error: logErr } = await supabase.from('task_activity_log').insert([
    { task_id: newTask.id, actor_id: user.id, action: 'task_copied',
      note: `copied this task from "${source.title}"` },
    { task_id: source.id, actor_id: user.id, action: 'task_copied',
      note: `copied this task and assigned it to ${assignee.full_name}` },
  ])
  if (logErr) console.error('[copy] activity log insert failed (non-fatal):', logErr.message)

  // 10. Standard assignment notification for the new assignee (best-effort).
  const { error: notifErr } = await insertUserNotifications(supabase, {
    user_id:      assigneeId,
    task_id:      newTask.id,
    type:         'task_assigned',
    title:        'New task assigned to you',
    body:         source.title,
    is_push_sent: true,
  })
  if (notifErr) console.error('[copy] notification insert failed (non-fatal):', notifErr.message)

  return NextResponse.json({ taskId: newTask.id, assigneeName: assignee.full_name })
}
