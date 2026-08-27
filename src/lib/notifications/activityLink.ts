// LINKING A NOTIFICATION TO THE ACTIVITY ROW THAT CAUSED IT.
//
// The id is never inferred. It is either handed over by the code that just
// created the activity row, or looked up by a rule that identifies exactly one
// row — never by matching a timestamp, which is the whole reason
// 20261016000000 exists.
//
// ── A CLIENT-SUPPLIED ID IS NOT TRUSTED ─────────────────────────────────────
//
// /api/notify-status-update takes its activity id from the browser, because the
// browser is what created the row. That id is verified before it is stored: the
// activity row must exist AND belong to the task the notification is about.
// Without that check a caller could point a notification at any activity row in
// the database, and the read path would then hand its note to the recipient —
// a comment on somebody else's task, delivered by asking for it.

/** Just the two reads this makes. See taskAssignees.ts for why `any`. */
type ActivityClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: 'task_activity_log') => any
}

type Row = { id?: unknown }

/**
 * Confirm a caller-supplied activity id belongs to the task in question.
 *
 * Returns the id when it checks out, and null otherwise — a bad id degrades the
 * notification to the historical fallback rather than failing the write. The
 * business action has already happened; a missing link is a worse notification,
 * not a failed one.
 */
export async function verifyActivityBelongsToTask(
  client: ActivityClient,
  activityLogId: string,
  taskId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from('task_activity_log')
    .select('id')
    .eq('id', activityLogId)
    .eq('task_id', taskId)
    .limit(1)
  if (error) return null
  const rows = (data ?? []) as Row[]
  return rows.length > 0 && typeof rows[0].id === 'string' ? rows[0].id : null
}

/**
 * The task's creation activity row, for an assignment notification.
 *
 * NOT A GUESS AND NOT A TIMESTAMP MATCH. Every task-creation path writes
 * exactly one row with `action = 'created'` for the task, so the rule
 * "the created row for this task" names one row by meaning. The ordering is for
 * DETERMINISM ACROSS RETRIES — the same call must return the same id every time
 * — not to pick between candidate events.
 *
 * Returns null when there is none, which is a real case: a copied task records
 * `task_copied` rather than `created`. The notification is written unlinked and
 * renders the fallback.
 *
 * This is also what makes assignment retry safe: the route re-derives the same
 * id rather than being handed one, so a retry after a partial failure links to
 * the SAME activity row and never creates another.
 */
export async function findTaskCreationActivityId(
  client: ActivityClient,
  taskId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from('task_activity_log')
    .select('id')
    .eq('task_id', taskId)
    .eq('action', 'created')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
  if (error) return null
  const rows = (data ?? []) as Row[]
  return rows.length > 0 && typeof rows[0].id === 'string' ? rows[0].id : null
}
