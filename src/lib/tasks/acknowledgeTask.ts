// Acknowledge, from the click to the notice — shared by the three screens that offer it (Task Detail, My Tasks, Dashboard).
//
// WHY THIS EXISTS. Each screen wrote `tasks` and then two `task_activity_log` rows as two browser calls, and never read the
// second call's error. A failure between them left a Working, acknowledged task with no permanent history and a page that
// said it had worked. They now call acknowledge_task() (20270303000000), which stamps the acknowledgement, moves the task to
// Working and writes BOTH history rows in ONE transaction.
//
// WHAT A CALLER MAY CONCLUDE — AND NOTHING MORE.
//   saved             the database ANSWERED this request: it is committed, history included. The only success.
//   refused           the database decided no; nothing changed.
//   own_action_found  the answer was lost; an acknowledgement of ours is saved. NOT "this request confirmed" — a second tab
//                     leaves the same row. The state is adopted; no success is claimed.
//   state_changed     the task is acknowledged in a way we cannot attribute to ourselves. Adopted, reported, nothing claimed.
//   not_saved         nothing of ours is saved. Safe to try again — by the person, never by this code.
//   unknown           cannot tell. Nothing is claimed; nothing is resent.
// The mutation is sent exactly ONCE per call, under one 30 s abort. This module never retries it.

import type { SupabaseClient } from '@supabase/supabase-js'

export const ACK_WRITE_TIMEOUT_MS = 30_000
const ACK_RECONCILE_TIMEOUT_MS = 10_000

export type AcknowledgeTaskRef = {
  id: string
  status: string
  created_at: string
  last_update_at?: string | null
}

export type AcknowledgeRequest = {
  task: AcknowledgeTaskRef
  /** The signed-in person. Sent to nobody: the database takes the actor from its own session. Used only to look for OUR history row. */
  actorId: string
}

/** What the screen adopts after an acknowledgement. Always Working: that is the only state the database leaves. */
export type AckState = { acknowledged_at: string; status: 'working'; last_update_at: string }

export type SavedAcknowledge = {
  state: AckState
  fromStatus: string
  acknowledgedLogId: string | null
  statusChangedLogId: string | null
}

export type AcknowledgeOutcome =
  | { kind: 'saved'; change: SavedAcknowledge }
  | { kind: 'refused'; message: string; code: string | null }
  | { kind: 'own_action_found'; state: AckState }
  | { kind: 'state_changed'; state: AckState }
  | { kind: 'not_saved' }
  | { kind: 'unknown' }

type DbError = { message: string; code?: string | null }

/** The part of a database message meant to be read: "TASK_ACK_FORBIDDEN: Only the…" -> "Only the…". */
function readable(message: string): string {
  const i = message.indexOf(':')
  return (i >= 0 ? message.slice(i + 1) : message).trim()
}

/** A code means the database (or PostgREST) answered: the write was decided. No code means it may or may not have landed. */
function isDecided(error: DbError): boolean {
  return !!error.code
}

/** 55000 = "not in the state this action needs", which includes "already acknowledged" — possibly OUR earlier send. */
function isStateConflict(error: DbError): boolean {
  return error.code === '55000'
}

type ReadBack =
  | { outcome: 'own_action_found'; state: AckState }
  | { outcome: 'unattributed'; state: AckState }
  | { outcome: 'not_applied' }
  | { outcome: 'unknown' }

async function readOnce(supabase: SupabaseClient, req: AcknowledgeRequest): Promise<ReadBack> {
  try {
    const since = req.task.last_update_at ?? req.task.created_at
    const [taskRes, logRes] = await Promise.all([
      supabase.from('tasks').select('acknowledged_at, status, last_update_at').eq('id', req.task.id)
        .abortSignal(AbortSignal.timeout(ACK_RECONCILE_TIMEOUT_MS)).single(),
      supabase.from('task_activity_log').select('id').eq('task_id', req.task.id).eq('actor_id', req.actorId)
        .eq('action', 'acknowledged').gt('created_at', since).limit(2)
        .abortSignal(AbortSignal.timeout(ACK_RECONCILE_TIMEOUT_MS)),
    ])
    if (taskRes.error || !taskRes.data || logRes.error) return { outcome: 'unknown' }
    const row = taskRes.data as { acknowledged_at: string | null; status: string; last_update_at: string | null }
    if (!row.acknowledged_at) return { outcome: 'not_applied' }
    const state: AckState = {
      acknowledged_at: row.acknowledged_at,
      status: row.status as 'working',
      last_update_at: row.last_update_at ?? row.acknowledged_at,
    }
    // Exactly one: two rows mean more than one acknowledgement of ours since the task was last seen, so the row cannot be
    // tied to this request.
    return (logRes.data ?? []).length === 1 ? { outcome: 'own_action_found', state } : { outcome: 'unattributed', state }
  } catch {
    return { outcome: 'unknown' }
  }
}

/** One read-back, then one more after `recheckMs` if it found nothing — a write that landed just before the read may not show yet. Reads only. */
async function readBack(supabase: SupabaseClient, req: AcknowledgeRequest, recheckMs: number): Promise<ReadBack> {
  const first = await readOnce(supabase, req)
  if (recheckMs <= 0 || (first.outcome !== 'unattributed' && first.outcome !== 'not_applied')) return first
  await new Promise(r => setTimeout(r, recheckMs))
  const second = await readOnce(supabase, req)
  return second.outcome === 'unknown' ? first : second
}

/**
 * Sends the acknowledgement ONCE and reports what can honestly be said about it. Never retries the mutation, never throws.
 */
export async function acknowledgeTask(
  supabase: SupabaseClient,
  req: AcknowledgeRequest,
  opts: { recheckMs?: number } = {},
): Promise<AcknowledgeOutcome> {
  let rpc: { data: unknown; error: DbError | null }
  try {
    rpc = await supabase.rpc('acknowledge_task', { p_task_id: req.task.id })
      .abortSignal(AbortSignal.timeout(ACK_WRITE_TIMEOUT_MS))
  } catch (e) {
    rpc = { data: null, error: { message: e instanceof Error ? e.message : 'Network error', code: null } }
  }

  if (!rpc.error) {
    const d = (rpc.data ?? {}) as Record<string, unknown>
    const last = typeof d.last_update_at === 'string' ? d.last_update_at : null
    const ack = typeof d.acknowledged_at === 'string' ? d.acknowledged_at : last
    const at = ack ?? new Date().toISOString()
    return {
      kind: 'saved',
      change: {
        state: { acknowledged_at: at, status: 'working', last_update_at: last ?? at },
        fromStatus: typeof d.from_status === 'string' ? d.from_status : req.task.status,
        acknowledgedLogId: typeof d.acknowledged_log_id === 'string' ? d.acknowledged_log_id : null,
        statusChangedLogId: typeof d.status_changed_log_id === 'string' ? d.status_changed_log_id : null,
      },
    }
  }

  const error = rpc.error
  const decided = isDecided(error)
  // A refusal the database MEANT (forbidden, not applicable, wrong status) changed nothing. The wrong-state refusal (55000,
  // including "already acknowledged") may be the database refusing a RE-SEND of a write that already applied, so it is
  // reconciled before it is shown.
  if (decided && !isStateConflict(error)) return { kind: 'refused', message: readable(error.message), code: error.code ?? null }

  const refused: AcknowledgeOutcome = { kind: 'refused', message: readable(error.message), code: error.code ?? null }
  const settled = await readBack(supabase, req, opts.recheckMs ?? 700)
  switch (settled.outcome) {
    case 'own_action_found': return { kind: 'own_action_found', state: settled.state }
    case 'unattributed':     return { kind: 'state_changed', state: settled.state }
    case 'not_applied':      return decided ? refused : { kind: 'not_saved' }
    default:                 return decided ? refused : { kind: 'unknown' }
  }
}

/** What to tell the person for every outcome that is not `saved`. Null for `saved`: the screen itself is the confirmation. */
export function acknowledgeMessage(outcome: AcknowledgeOutcome): string | null {
  switch (outcome.kind) {
    case 'saved':            return null
    case 'refused':          return outcome.message || 'Failed to acknowledge task. Please try again.'
    case 'own_action_found': return 'This task is now acknowledged under your name, but we cannot match it to this exact request (it could also be another tab or an earlier attempt of yours), so it is not treated as confirmed. Nothing was sent again.'
    case 'state_changed':    return 'This task is now acknowledged, but we cannot confirm that your request is what did it — it may have been acknowledged from another tab. It has been refreshed. Nothing was sent again.'
    case 'not_saved':        return 'We could not find your acknowledgement saved. Nothing was sent again — you can try again.'
    case 'unknown':          return 'The connection dropped and we could not confirm whether the acknowledgement was saved. Refresh the task before trying again.'
  }
}

/** The state to ADOPT on screen, if the outcome carries one (it never invents one). */
export function adoptableAck(outcome: AcknowledgeOutcome): AckState | null {
  if (outcome.kind === 'saved') return outcome.change.state
  if (outcome.kind === 'own_action_found' || outcome.kind === 'state_changed') return outcome.state
  return null
}

/**
 * Whether the creator is told. Today's rule, unchanged: they are told once an acknowledgement of ours is saved. A lost answer
 * that is read back as ours counts — the page never reached the notice step, so skipping it would silence the creator.
 */
export function shouldAnnounceAck(outcome: AcknowledgeOutcome): boolean {
  return outcome.kind === 'saved' || outcome.kind === 'own_action_found'
}

/** The creator's notice, exactly as each screen sent it before: fire-and-forget, failures logged, never blocking. */
export function postAcknowledgedNotice(
  p: { taskId: string; taskTitle: string; createdBy: string | null; actorId: string; actorName?: string | null },
  tag: string,
  post: typeof fetch = fetch,
): void {
  if (!p.createdBy || p.createdBy === p.actorId) return
  post('/api/notify-status-update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: p.taskId, taskTitle: p.taskTitle, createdBy: p.createdBy, action: 'acknowledged', actorName: p.actorName }),
  }).then(res => {
    if (!res.ok) res.json().then(d => console.error(`[${tag}] notification failed:`, d))
  }).catch(err => console.error(`[${tag}] notification fetch error:`, err))
}
