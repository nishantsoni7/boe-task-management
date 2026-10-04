// What a status notice is allowed to say, derived from the DURABLE EVENT it announces.
//
// A status change leaves a `task_activity_log` row: who did it, to which task, from which status to which. That row is the
// fact. The notice announces THAT EVENT, and everything the notice needs — the action, the recipient, the type — can be
// read off the event and the stored task, so none of it has to be believed from the request.
//
// WHY THIS MATTERS FOR RECOVERY. When the response to a status change is lost, the page finds the event afterwards (its own
// history row, via the read-only reconcile) and announces THAT event. The route must therefore check the event against the
// notice it is asked to write, rather than accept a caller's words about an event it can read for itself:
//
//   · the event belongs to this task;
//   · it is a status change, authored by the CALLER (nobody announces somebody else's action);
//   · the action named, if any, is the status the event moved to — and the headline is built from the EVENT's status;
//   · the recipient is the OTHER party of the stored task, never a name the request supplied;
//   · the type is fixed.
//
// WHAT THIS DOES NOT DO — AND MUST NOT CLAIM. Finding a matching event is not proof that THIS request wrote it: a second tab
// of the same person produces an identical event. The notice is tied to the EVENT, which is what the recipient needs to hear
// about; whether this particular click caused it is not asked and not answered here, and nothing in the response says
// "confirmed". Sending twice is made harmless by the database key (notifications_event_once_idx), not by this check.

/** The columns of the activity row this reads. */
export type ActivityEvent = {
  id: string
  task_id: string
  actor_id: string | null
  action: string
  from_status: string | null
  to_status: string | null
}

export type EventTaskFacts = { id: string; created_by: string | null; assigned_to: string | null }

/** The only notification type a status notice carries. */
export const STATUS_NOTICE_TYPE = 'task_acknowledged' as const

/**
 * The statuses a status notice from this route may announce. Anything else — an unknown label, a status another writer owns —
 * is refused, so a status notice can only ever say one of these.
 */
export const ALLOWED_STATUS_ACTIONS = new Set(['pending', 'started', 'working', 'waiting', 'blocked', 'completed'])

/**
 * Statuses whose notices are written by the thing that made the change (the review function; the cancel route), not by the
 * status-update route. An event moving to one of them is refused here, so the same event can never be announced twice by
 * two different writers.
 */
export const ANNOUNCED_ELSEWHERE = new Set(['pending_approval', 'cancelled'])

export type EventNotice =
  | { ok: true; eventId: string; recipientId: string; action: string; type: typeof STATUS_NOTICE_TYPE }
  | { ok: false; reason: EventNoticeRefusal }

export type EventNoticeRefusal =
  | 'event_not_this_task'
  | 'event_not_a_status_change'
  | 'event_not_by_caller'
  | 'announced_elsewhere'
  | 'status_not_allowed'
  | 'action_mismatch'
  | 'recipient_mismatch'
  | 'no_other_party'

/**
 * The notice an event licenses, or why it licenses none. `claimed` is what the request said; a claim that disagrees with the
 * event is REFUSED, never silently overridden — a disagreement means the caller and the database hold different facts.
 */
export function deriveNoticeFromEvent(
  event: ActivityEvent,
  task: EventTaskFacts,
  callerId: string,
  claimed: { action?: unknown; recipientId?: unknown } = {},
): EventNotice {
  if (event.task_id !== task.id) return { ok: false, reason: 'event_not_this_task' }
  if (event.action !== 'status_changed' || !event.to_status) return { ok: false, reason: 'event_not_a_status_change' }
  if (event.actor_id !== callerId) return { ok: false, reason: 'event_not_by_caller' }
  if (ANNOUNCED_ELSEWHERE.has(event.to_status)) return { ok: false, reason: 'announced_elsewhere' }
  if (!ALLOWED_STATUS_ACTIONS.has(event.to_status)) return { ok: false, reason: 'status_not_allowed' }

  const action = event.to_status
  if (claimed.action !== undefined && claimed.action !== null && claimed.action !== action) {
    return { ok: false, reason: 'action_mismatch' }
  }

  // The other party of the STORED task, from the caller's side of it.
  const recipientId =
    callerId === task.created_by ? task.assigned_to
    : callerId === task.assigned_to ? task.created_by
    : null
  if (!recipientId) return { ok: false, reason: 'no_other_party' }
  if (claimed.recipientId !== undefined && claimed.recipientId !== null && claimed.recipientId !== recipientId) {
    return { ok: false, reason: 'recipient_mismatch' }
  }

  return { ok: true, eventId: event.id, recipientId, action, type: STATUS_NOTICE_TYPE }
}
