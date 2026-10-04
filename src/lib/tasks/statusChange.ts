// One status change, from the click to the notice — shared by every caller that saves a status.
//
// WHY THIS EXISTS. Task Detail's status change, its waiting modal and My Tasks' quick-complete each wrote `tasks` and then
// `task_activity_log` as two browser calls, then sent a notice. A failure between the two left a changed task with no history
// and the page claiming success. They now go through change_task_status() (20270302000000), which writes the status, the resets
// and the history row in ONE transaction, and then announce the EVENT it returns.
//
// WHAT A CALLER MAY CONCLUDE — AND NOTHING MORE.
//   saved             the database ANSWERED this request: it is committed (and its history row exists). The only success.
//   refused           the database decided no; nothing changed.
//   own_action_found  the answer was lost; an action of ours is saved. NOT "this request confirmed" — a second tab leaves
//                     the same row. The state is adopted and the event is announced; no success is claimed.
//   state_changed     the task is now in a state we cannot attribute to ourselves. Adopted, reported, nothing claimed.
//   not_saved         nothing of ours is saved. Safe to try again — by the person, never by this code.
//   unknown           cannot tell. Nothing is claimed; nothing is resent.
// The mutation is sent exactly ONCE per call. This module never retries it.
//
// THE NOTICE is a separate step with its own safety: it announces an event by id, and the database key (one notice per event,
// per recipient, per type) makes a repeat harmless — so, unlike the mutation, the notice MAY be sent again after a transport
// failure. That is the only retry anywhere in this file.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  WRITE_TIMEOUT_MS, classifyWriteFailure, isStateConflict, reconcileSavedStatus, recoveryMessage,
  type SavedTaskState,
} from '@/lib/tasks/taskDetailLoad'

export type StatusChangeTask = {
  id: string
  status: string
  created_by: string | null
  assigned_to: string | null
  created_at: string
  last_update_at?: string | null
}

export type WaitingDetail = { type: 'team_member' | 'external'; userId?: string | null; text?: string | null }

export type StatusChangeRequest = {
  task: StatusChangeTask
  /** The signed-in person. Sent to nobody: the database takes the actor from its own session. Used only to look for OUR history row. */
  actorId: string
  status: string
  reason?: string | null
  attachmentUrl?: string | null
  waiting?: WaitingDetail
}

export type SavedChange = {
  saved: SavedTaskState
  /** The history row this change wrote, in the same transaction. Null only if the database returned none (it always does). */
  eventId: string | null
  fromStatus: string
  /** When the change happened, by the database's clock. */
  at: string | null
}

export type StatusChangeOutcome =
  | { kind: 'saved'; change: SavedChange }
  | { kind: 'refused'; message: string; code: string | null }
  | { kind: 'own_action_found'; saved: SavedTaskState; eventId: string }
  | { kind: 'state_changed'; saved: SavedTaskState }
  | { kind: 'not_saved' }
  | { kind: 'unknown' }

/** The part of a database message meant to be read: "TASK_STATUS_FORBIDDEN: Only the…" -> "Only the…". */
function readable(message: string): string {
  const i = message.indexOf(':')
  return (i >= 0 ? message.slice(i + 1) : message).trim()
}

/**
 * Sends the change ONCE and reports what can honestly be said about it. Never retries the mutation, never throws.
 */
export async function changeTaskStatus(supabase: SupabaseClient, req: StatusChangeRequest): Promise<StatusChangeOutcome> {
  const { task, actorId, status } = req
  let rpc: { data: unknown; error: { message: string; code?: string | null } | null }
  try {
    rpc = await supabase.rpc('change_task_status', {
      p_task_id:            task.id,
      p_status:             status,
      p_reason:             req.reason ?? null,
      p_attachment_url:     req.attachmentUrl ?? null,
      p_waiting_on_type:    req.waiting?.type ?? null,
      p_waiting_on_user_id: req.waiting?.type === 'team_member' ? (req.waiting.userId ?? null) : null,
      p_waiting_on_text:    req.waiting?.type === 'external' ? (req.waiting.text ?? null) : null,
    }).abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS))
  } catch (e) {
    rpc = { data: null, error: { message: e instanceof Error ? e.message : 'Network error', code: null } }
  }

  if (!rpc.error) {
    const d = (rpc.data ?? {}) as Record<string, unknown>
    const saved: SavedTaskState = {
      status:             String(d.status ?? status) as SavedTaskState['status'],
      completed_at:       (d.completed_at as string | null) ?? null,
      last_update_at:     (d.last_update_at as string | null) ?? null,
      blocker_reason:     (d.blocker_reason as string | null) ?? null,
      waiting_on_type:    (d.waiting_on_type as SavedTaskState['waiting_on_type']) ?? null,
      waiting_on_user_id: (d.waiting_on_user_id as string | null) ?? null,
      waiting_on_text:    (d.waiting_on_text as string | null) ?? null,
    }
    return {
      kind: 'saved',
      change: {
        saved,
        eventId:    typeof d.activity_log_id === 'string' ? d.activity_log_id : null,
        fromStatus: typeof d.from_status === 'string' ? d.from_status : task.status,
        at:         saved.last_update_at ?? null,
      },
    }
  }

  const error = rpc.error
  const decided = classifyWriteFailure(error) === 'rejected'
  // A refusal the database MEANT (forbidden, not acknowledged, invalid) changed nothing. The wrong-state refusal (55000) is
  // different: it may be the database refusing a RE-SEND of a write that already applied, so it is reconciled before it is shown.
  if (decided && !isStateConflict(error)) return { kind: 'refused', message: readable(error.message), code: error.code ?? null }

  const settled = await reconcileSavedStatus(supabase, task.id, {
    actorId,
    expectedStatus: status,
    previousStatus: task.status,
    since:          task.last_update_at ?? task.created_at,
  })
  switch (settled.outcome) {
    case 'own_action_found': return { kind: 'own_action_found', saved: settled.saved, eventId: settled.eventId }
    case 'unattributed':
    case 'changed':          return { kind: 'state_changed', saved: settled.saved }
    case 'not_applied':      return decided ? { kind: 'refused', message: readable(error.message), code: error.code ?? null } : { kind: 'not_saved' }
    default:                 return decided ? { kind: 'refused', message: readable(error.message), code: error.code ?? null } : { kind: 'unknown' }
  }
}

/** What to tell the person for every outcome that is not `saved`. Null for `saved`: the screen itself is the confirmation. */
export function statusChangeMessage(outcome: StatusChangeOutcome, previousStatus: string): string | null {
  switch (outcome.kind) {
    case 'saved':            return null
    case 'refused':          return outcome.message || 'Failed to update task status. Please try again.'
    case 'own_action_found': return recoveryMessage('own_action_found', outcome.saved.status)
    case 'state_changed':    return recoveryMessage('changed', outcome.saved.status)
    case 'not_saved':        return recoveryMessage('not_applied', previousStatus)
    case 'unknown':          return 'The connection dropped and we could not confirm whether this change was saved. Refresh the status before trying again.'
  }
}

/** The saved state to ADOPT on screen, if the outcome carries one (it never invents one). */
export function adoptableState(outcome: StatusChangeOutcome): SavedTaskState | null {
  if (outcome.kind === 'saved') return outcome.change.saved
  if (outcome.kind === 'own_action_found' || outcome.kind === 'state_changed') return outcome.saved
  return null
}

// ── The notice ───────────────────────────────────────────────────────────────

export type NoticeResult =
  | 'sent'               // written
  | 'already_announced'  // the event was already announced to this person (a repeat is harmless)
  | 'not_announced'      // nobody to tell (a self task) or not announced by rule
  | 'no_event'           // there is no event to announce — nothing is sent
  | 'refused'            // the route refused (422/403/401): not retried
  | 'failed'             // transport failure or 5xx, even after the one safe retry

export type NoticePost = (body: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> | null }>

/** The browser's way to post a notice. Tests inject their own. */
export const browserNoticePost: NoticePost = async body => {
  const res = await fetch('/api/notify-status-update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let json: Record<string, unknown> | null = null
  try { json = await res.json() } catch { /* a non-JSON error page */ }
  return { status: res.status, json }
}

/**
 * Announces ONE status event to the other party of the task. Safe to call more than once for the same event: the route and the
 * database key answer "already announced". The retry on a transport failure or a 5xx is therefore safe — and is the only retry
 * in this module; the mutation itself is never resent.
 */
export async function sendStatusNotice(
  post: NoticePost,
  p: { task: Pick<StatusChangeTask, 'id' | 'created_by' | 'assigned_to'>; actorId: string; status: string; eventId: string | null },
  retryDelayMs = 300,
): Promise<NoticeResult> {
  if (!p.eventId) return 'no_event'
  const recipientId = p.actorId === p.task.created_by ? p.task.assigned_to : p.task.created_by
  if (!recipientId || recipientId === p.actorId) return 'not_announced'
  const body = { taskId: p.task.id, recipientId, action: p.status, activityLogId: p.eventId }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await post(body)
      if (res.status >= 200 && res.status < 300) {
        if (res.json?.duplicate === true) return 'already_announced'
        if (res.json?.skipped === true) return 'not_announced'
        return 'sent'
      }
      if (res.status < 500) return 'refused'
    } catch { /* fall through to the one retry */ }
    if (attempt === 0) await new Promise(r => setTimeout(r, retryDelayMs))
  }
  return 'failed'
}
