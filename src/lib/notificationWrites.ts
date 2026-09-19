// The single application-side gate on writing a `notifications` row.
//
// Every Task Management notification is created by a person doing something —
// acknowledging, changing status, commenting, cancelling, reopening, copying a
// task. None of those may be suppressed: each one tells the other party that
// their task moved, and several are the only prompt that party gets.
//
// What must never be created is a row the SYSTEM produced about itself.
// src/lib/notifications.ts names those types once
// (SYSTEM_GENERATED_NOTIFICATION_TYPES) and this is where that name is
// enforced on the write side, so a future "the system noticed X" feature
// cannot quietly reintroduce the noise by inserting directly.
//
// AND A ROW ADDRESSED TO THE PERSON WHO CAUSED IT. Telling someone what they
// just did themselves is noise of exactly the same kind: a comment, a status
// change or a submit-for-approval is already on their screen, in the feed they
// are looking at, when they perform it. Every task write path ALREADY refuses
// this individually — `notifyUserId === user.id` in /api/notify-status-update,
// `recipient !== currentUserId` at each browser call site, `v_recipient <>
// v_uid` inside transition_task_review(). Those checks are the reason the
// defect is not live today; they are ALSO seven separate copies of one rule,
// and the eighth path to be written is the one that forgets. So the rule is
// stated once more HERE, at the single funnel every Task Management
// notification passes through, where it cannot be forgotten by a new caller.
// Pass `actorId` and a row addressed to that person is dropped.
//
// SUPPRESSION IS NOT FAILURE. The business action that produced the row has
// already committed by the time any of this runs; a suppressed notification is
// reported as `suppressed`, never as an error, and never rolls anything back.
//
// SCOPE. Wired into the four Task Management server routes that insert
// notifications. Finance, Orders, Assets and Attendance/Payroll build their
// rows from their own closed enum lists — none of which contains a system type
// — and their routes are pinned by source-text tests, so they are left exactly
// as they are and the read-side exclusion covers them.

import { partitionSystemNotifications } from '@/lib/notifications'

/** The shape every caller already builds. Extra columns pass through untouched. */
export type NotificationInsert = {
  user_id: string
  task_id?: string | null
  entity_id?: string | null
  type: string
  title: string
  body?: string | null
  is_push_sent?: boolean
  /**
   * The exact `task_activity_log` row this announces (20261016000000).
   *
   * Omitted or null is normal and always will be: historical rows have none,
   * and a writer that has no activity row to point at must not invent one. The
   * feed renders its fallbacks for those. What must never happen is a value
   * derived from a timestamp — see the migration.
   */
  activity_log_id?: string | null
}

/**
 * Just enough of the Supabase client to insert — keeps this unit testable.
 *
 * `PromiseLike`, not `Promise`: PostgREST's builder is a thenable that only
 * issues its request when awaited, so the narrower type would not accept a
 * real client.
 */
export type NotificationInsertClient = {
  from: (table: 'notifications') => {
    insert: (rows: NotificationInsert[]) => PromiseLike<{ error: { message: string } | null }>
  }
}

export type NotificationInsertResult = {
  /** Rows actually sent to the database. */
  inserted: number
  /** Rows the system-activity rule dropped. Never an error. */
  suppressed: number
  /**
   * Rows dropped because the recipient IS the person who acted. Counted apart
   * from `suppressed` so the two rules stay legible in logs and tests: one is
   * "the system talking to itself", the other is "you telling yourself".
   */
  selfSuppressed: number
  /** The insert's own error, unchanged, or null. */
  error: { message: string } | null
}

/** Everything the guard needs beyond the rows themselves. */
export type NotificationInsertOptions = {
  /**
   * The signed-in person whose action produced these rows.
   *
   * Supply it whenever one is known. Omitting it is not an error — a scheduled
   * or system-initiated write genuinely has no actor — but every Task
   * Management route has one and passes it.
   */
  actorId?: string | null
}

/**
 * Insert user-facing notifications, dropping any system-generated row first.
 *
 * `is_push_sent` is the column a push transport reads to decide what still
 * needs delivering, so a suppressed row produces no in-app record AND no push
 * — there is nothing left for a transport to pick up. That is the whole
 * mechanism: suppression happens before the row exists, not after.
 *
 * An all-suppressed batch performs no database call at all and returns
 * `{ inserted: 0, error: null }` — a success, because nothing needed doing.
 */
export async function insertUserNotifications(
  client: NotificationInsertClient,
  rows: NotificationInsert | readonly NotificationInsert[],
  options: NotificationInsertOptions = {},
): Promise<NotificationInsertResult> {
  const all = Array.isArray(rows) ? rows : [rows as NotificationInsert]
  const { deliverable, suppressed } = partitionSystemNotifications(all)

  const actorId = typeof options.actorId === 'string' && options.actorId ? options.actorId : null
  const addressed = actorId ? deliverable.filter(r => r.user_id !== actorId) : deliverable
  const selfSuppressed = deliverable.length - addressed.length

  if (addressed.length === 0) {
    return { inserted: 0, suppressed: suppressed.length, selfSuppressed, error: null }
  }

  const { error } = await client.from('notifications').insert(addressed)
  return {
    inserted: error ? 0 : addressed.length,
    suppressed: suppressed.length,
    selfSuppressed,
    error: error ?? null,
  }
}
