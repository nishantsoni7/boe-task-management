import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { purgeUserResults } from '@/lib/imageEditor/history'
import { HISTORY_BUCKET } from '@/lib/imageEditor/retention'

export async function POST(req: NextRequest) {
  const { userId } = await req.json()

  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }

  const authHeader = req.headers.get('authorization') ?? ''
  const callerToken = authHeader.replace('Bearer ', '').trim()
  if (!callerToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const serviceClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: { user: caller }, error: callerError } = await serviceClient.auth.getUser(callerToken)
  if (callerError || !caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: callerProfile } = await serviceClient
    .from('users')
    .select('role')
    .eq('id', caller.id)
    .single()

  if (callerProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Only admins can permanently delete members' }, { status: 403 })
  }

  // Confirm target exists and is already soft-deleted
  const { data: target, error: targetError } = await serviceClient
    .from('users')
    .select('id, is_deleted')
    .eq('id', userId)
    .single()

  if (targetError || !target) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 })
  }

  if (!target.is_deleted) {
    return NextResponse.json({ error: 'Member must be soft-deleted before permanently deleting' }, { status: 400 })
  }

  // ── Cascade cleanup in safe order ────────────────────────────────────────

  // a. Image Editor history — BEFORE anything else is touched, and the only
  //    step that can stop the deletion.
  //
  //    These rows are the only record of where their storage objects live, so
  //    they cannot be allowed to go first: 20261021000000 makes the foreign key
  //    ON DELETE RESTRICT precisely so a cascade cannot destroy them and orphan
  //    the bytes. Emptying the history here — object then row, then anything
  //    left under the employee's prefix — is what makes the RESTRICT pass.
  //
  //    A failure stops the whole deletion, before a single other row has been
  //    removed. That is deliberate: an administrator can press Delete again,
  //    and a member who is still here is a far smaller problem than a bucket of
  //    objects nothing can ever reach. If the migration has not been applied
  //    the table is absent, there is nothing stored, and this is a no-op.
  const purge = await purgeUserResults(
    {
      storage: serviceClient.storage.from(HISTORY_BUCKET),
      listRows: async (ownerId) => {
        const { data, error } = await serviceClient
          .from('image_editor_results')
          .select('id, user_id, storage_path')
          .eq('user_id', ownerId)
        return {
          data: data as { id: string; user_id: string; storage_path: string }[] | null,
          error: error ? { message: error.message, code: error.code } : null,
        }
      },
      deleteRow: async (rowId, ownerId) => {
        const { error } = await serviceClient
          .from('image_editor_results')
          .delete()
          .eq('id', rowId)
          .eq('user_id', ownerId)
        return { error: error ? { message: error.message } : null }
      },
    },
    userId,
  )

  if (!purge.ok) {
    console.error('[permanently-delete-user] image editor history not emptied:', purge.reasons.join('; '))
    return NextResponse.json(
      {
        error:
          'This member\'s Image Editor results could not be removed, so nothing was deleted. ' +
          'Please try again.',
      },
      { status: 500 },
    )
  }

  // b. Notifications
  const { count: notifCount } = await serviceClient
    .from('notifications')
    .delete({ count: 'exact' })
    .eq('user_id', userId)

  // c. Password reset log
  const { count: resetCount } = await serviceClient
    .from('password_reset_log')
    .delete({ count: 'exact' })
    .or(`target_id.eq.${userId},actor_id.eq.${userId}`)

  // d. Activity log rows tied to tasks that reference this user
  const { data: linkedTasks } = await serviceClient
    .from('tasks')
    .select('id')
    .or(`assigned_to.eq.${userId},created_by.eq.${userId},delegated_by.eq.${userId},waiting_on_user_id.eq.${userId}`)

  const linkedTaskIds = (linkedTasks ?? []).map((t: { id: string }) => t.id)

  let activityFromTasksCount = 0
  if (linkedTaskIds.length > 0) {
    const { count } = await serviceClient
      .from('task_activity_log')
      .delete({ count: 'exact' })
      .in('task_id', linkedTaskIds)
    activityFromTasksCount = count ?? 0
  }

  // e. Activity log rows where this user was the actor
  const { count: activityByUserCount } = await serviceClient
    .from('task_activity_log')
    .delete({ count: 'exact' })
    .eq('actor_id', userId)

  // f. Tasks referencing this user
  const { count: taskCount } = await serviceClient
    .from('tasks')
    .delete({ count: 'exact' })
    .or(`assigned_to.eq.${userId},created_by.eq.${userId},delegated_by.eq.${userId},waiting_on_user_id.eq.${userId}`)

  // g. Clear deleted_by pointers from other users that reference this user
  await serviceClient
    .from('users')
    .update({ deleted_by: null })
    .eq('deleted_by', userId)

  // h. Delete from public.users
  const { error: deleteRowError } = await serviceClient
    .from('users')
    .delete()
    .eq('id', userId)

  if (deleteRowError) {
    return NextResponse.json({ error: deleteRowError.message }, { status: 500 })
  }

  // i. Delete from auth.users via Admin API
  const { error: deleteAuthError } = await serviceClient.auth.admin.deleteUser(userId)

  if (deleteAuthError) {
    console.error('[permanently-delete-user] auth.admin.deleteUser failed:', deleteAuthError.message)
  }

  return NextResponse.json({
    success: true,
    deleted: {
      imageEditorResults: purge.rowsDeleted,
      imageEditorOrphanObjects: purge.orphanObjects,
      notifications: notifCount ?? 0,
      passwordResetLogs: resetCount ?? 0,
      activityLogs: activityFromTasksCount + (activityByUserCount ?? 0),
      tasks: taskCount ?? 0,
    },
  })
}
