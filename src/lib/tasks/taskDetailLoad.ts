// Task Detail's reads and the three rules that keep a slow or failed one from
// stalling the page.
//
// Everything here is pure or takes the client as an argument, so each rule has
// a test that runs it. The page (src/app/tasks/[id]/page.tsx) only wires them.
//
//  1. ESSENTIAL vs SECONDARY. The task row is what the page needs to be usable;
//     the activity history and the attachment list are panels. They used to be
//     one three-way Promise.all behind a full-screen loader, and every mutation
//     re-read the second pair before it let go of its busy flag — so a slow
//     history read held a finished submission on the page.
//  2. A READ NEVER REJECTS INTO THE PAGE. Each reader folds a thrown error and a
//     returned error into a result the caller can render and retry. Before, a
//     query error was ignored and drew "Task not found".
//  3. AN UNCERTAIN WRITE IS RECONCILED, NOT REPEATED. A failure that carries no
//     database code (a dropped connection, a timeout, a gateway error) does not
//     say whether the write landed. The caller reads the saved row and decides;
//     it never sends the mutation again on its own.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Task, LogEntry, TaskAttachment } from '@/lib/types'

type ReadError = { message: string; code?: string | null }

const ACTIVITY_COLUMNS =
  'id, action, note, from_status, to_status, old_val, new_val, created_at, actor_id, attachment_url, users:actor_id ( full_name )'

// ─── Essential read: the task ───────────────────────────────────────────────

export type EssentialRead =
  | { status: 'ok'; task: Task; creatorName: string | null }
  /** Zero rows: the task does not exist, or RLS will not show it to this caller. */
  | { status: 'not_found' }
  /** The read itself failed — the task may well exist. Recoverable by retrying. */
  | { status: 'error'; message: string }

/** PostgREST's answer to `.single()` when no row matches. */
const NO_ROWS = 'PGRST116'

export async function readTaskEssential(supabase: SupabaseClient, taskId: string): Promise<EssentialRead> {
  try {
    const { data, error } = await supabase
      .from('tasks')
      .select('*, creator:created_by(full_name)')
      .eq('id', taskId)
      .single()
    if (error) {
      return error.code === NO_ROWS
        ? { status: 'not_found' }
        : { status: 'error', message: error.message || 'The task could not be loaded.' }
    }
    if (!data) return { status: 'not_found' }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { creator, ...task } = data as any
    return { status: 'ok', task: task as Task, creatorName: creator?.full_name ?? null }
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : 'The task could not be loaded.' }
  }
}

// ─── Secondary read: activity history + attachments ─────────────────────────

export type SecondaryRead =
  | { status: 'ok'; log: LogEntry[]; taskLevelAttachments: TaskAttachment[] }
  | { status: 'error'; message: string }

/** Splits attachments into task-level ones and per-activity ones, and joins the latter onto their rows. */
export function buildActivityLog(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[],
  attachments: TaskAttachment[],
): { log: LogEntry[]; taskLevelAttachments: TaskAttachment[] } {
  const byLogId: Record<string, TaskAttachment[]> = {}
  const taskLevelAttachments: TaskAttachment[] = []
  for (const att of attachments) {
    if (!att.activity_log_id) taskLevelAttachments.push(att)
    else (byLogId[att.activity_log_id] ??= []).push(att)
  }
  const log = rows.map(e => ({
    ...e,
    actor_name:     e.users?.full_name ?? null,
    old_val:        e.old_val ?? null,
    new_val:        e.new_val ?? null,
    attachment_url: e.attachment_url ?? null,
    attachments:    byLogId[e.id] ?? [],
  })) as LogEntry[]
  return { log, taskLevelAttachments }
}

/**
 * Both panels, or an error. Never half: showing a history without its
 * attachments (or clearing the gallery because one read failed) would be a
 * wrong picture of the task, so a failed pair leaves what is on screen alone.
 */
export async function readTaskSecondary(supabase: SupabaseClient, taskId: string): Promise<SecondaryRead> {
  try {
    const [logRes, attRes] = await Promise.all([
      supabase.from('task_activity_log').select(ACTIVITY_COLUMNS).eq('task_id', taskId).order('created_at', { ascending: false }),
      supabase.from('task_attachments').select('*').eq('task_id', taskId).order('created_at', { ascending: true }),
    ])
    const failed: ReadError | null = logRes.error ?? attRes.error
    if (failed) return { status: 'error', message: failed.message || 'The activity could not be loaded.' }
    const built = buildActivityLog(logRes.data ?? [], (attRes.data ?? []) as TaskAttachment[])
    return { status: 'ok', ...built }
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : 'The activity could not be loaded.' }
  }
}

/**
 * Folds a fresh read into what is already on screen without losing a row the
 * screen holds and the read could not yet have seen: one newer than everything
 * the read returned (written locally while the read was in flight). Rows the
 * read does not contain but that are older are gone server-side and are dropped.
 */
export function mergeActivityRead(read: LogEntry[], current: LogEntry[]): LogEntry[] {
  if (current.length === 0) return read
  const seen = new Set(read.map(e => e.id))
  const newest = read.length ? read.reduce((m, e) => (e.created_at > m ? e.created_at : m), read[0].created_at) : ''
  const newer = current.filter(e => !seen.has(e.id) && e.created_at > newest)
  return newer.length ? [...newer, ...read] : read
}

// ─── Latest-wins gate ───────────────────────────────────────────────────────

/**
 * A response may change the screen only if it is the newest request of its
 * kind AND the page has not moved on. `begin()` hands out a ticket; any later
 * `begin()` or `close()` retires every earlier ticket.
 */
export function createLatestGate() {
  let latest = 0
  let closed = false
  return {
    begin(): number { return ++latest },
    isCurrent(ticket: number): boolean { return !closed && ticket === latest },
    close(): void { closed = true; latest++ },
    /** Re-arms a closed gate — React StrictMode runs an effect's cleanup and then its setup again. */
    open(): void { closed = false },
  }
}

// ─── Uncertain writes ───────────────────────────────────────────────────────

/**
 * `rejected`: the database (or PostgREST) answered, so the write was decided —
 * it did not happen. `uncertain`: the request failed in transit and carries no
 * database code, so it may or may not have been applied.
 */
export function classifyWriteFailure(error: ReadError | null | undefined): 'rejected' | 'uncertain' {
  return error?.code ? 'rejected' : 'uncertain'
}

/**
 * The database's "this task is not in the state that action needs" (TASK_REVIEW_INVALID_SOURCE, SQLSTATE 55000).
 * It is a decision, but not always a decision about OUR request: a browser re-sends a POST whose connection was reset
 * on a reused socket, so the first send can have applied and the re-send is what the database refuses. The refusal
 * therefore proves nothing about whether the change is saved — the caller reads the saved state before showing it.
 */
export function isStateConflict(error: ReadError | null | undefined): boolean {
  return error?.code === '55000'
}

export type ReviewAction = 'submit' | 'approve' | 'return'

/** The status each review action leaves the task in. */
export const REVIEW_RESULT_STATUS: Record<ReviewAction, string> = {
  submit:  'pending_approval',
  approve: 'completed',
  return:  'working',
}

const SAVED_STATE_COLUMNS =
  'status, completed_at, last_update_at, blocker_reason, waiting_on_type, waiting_on_user_id, waiting_on_text'

export type SavedTaskState = Pick<Task,
  'status' | 'completed_at' | 'last_update_at' | 'blocker_reason' | 'waiting_on_type' | 'waiting_on_user_id' | 'waiting_on_text'>

export type Reconciled =
  /**
   * The row shows the expected status and EXACTLY ONE activity row of ours explains it. This is evidence that the
   * change is saved under this person's name — it is NOT proof that THIS request wrote it: a second tab of the same
   * person, or an earlier attempt, produces the same row. Callers must not report it as a confirmed success of this
   * request (see the comment on reconcileSavedStatus).
   */
  | { outcome: 'applied'; saved: SavedTaskState }
  /**
   * The row shows the expected status but no activity row of ours explains it, or SEVERAL do. Somebody else (or
   * another tab) made the move, or our write landed and its row is not visible. Never claimed.
   */
  | { outcome: 'unattributed'; saved: SavedTaskState }
  /** The row still shows the status it had before and nothing of ours explains a change: no saved change was found. */
  | { outcome: 'not_applied'; saved: SavedTaskState }
  /** The row holds some other status, or an inconsistent mix — it moved without us. */
  | { outcome: 'changed'; saved: SavedTaskState }
  /** The row or its history could not be read, so nothing can be said. */
  | { outcome: 'unknown' }

export type ReconcileSpec = {
  /** The signed-in person: the only author an activity row can have to count as ours. */
  actorId: string
  /** The status a successful write leaves. Null when it is not a single value (reopen restores the previous status). */
  expectedStatus: string | null
  /** The status the task held when the write was sent. */
  previousStatus: string
  /** Rows written at or before this instant belong to earlier actions — the task's last_update_at (else created_at) as last seen. */
  since: string
}

export type ReconcileOptions = {
  /**
   * When the first read says "unattributed" or "not applied", look once more after this many ms before saying so:
   * a write that landed just before the read may not be visible yet. Bounded, read-only. 0 disables it.
   */
  recheckMs?: number
}

async function readOnce(supabase: SupabaseClient, taskId: string, spec: ReconcileSpec): Promise<Reconciled> {
  try {
    let logQuery = supabase
      .from('task_activity_log')
      .select('id')
      .eq('task_id', taskId)
      .eq('actor_id', spec.actorId)
      .eq('action', 'status_changed')
      .eq('from_status', spec.previousStatus)
      .gt('created_at', spec.since)
    if (spec.expectedStatus) logQuery = logQuery.eq('to_status', spec.expectedStatus)
    const [taskRes, logRes] = await Promise.all([
      supabase.from('tasks').select(SAVED_STATE_COLUMNS).eq('id', taskId).single(),
      logQuery.limit(2),
    ])
    if (taskRes.error || !taskRes.data || logRes.error) return { outcome: 'unknown' }
    const saved = taskRes.data as unknown as SavedTaskState
    const matching = (logRes.data ?? []).length
    const moved = spec.expectedStatus ? saved.status === spec.expectedStatus : saved.status !== spec.previousStatus
    // Exactly one: two matching rows mean more than one action of ours since the task was last seen (two tabs, or
    // an earlier attempt that landed late) and the row cannot be tied to this request.
    if (moved) return matching === 1 ? { outcome: 'applied', saved } : { outcome: 'unattributed', saved }
    if (saved.status === spec.previousStatus && matching === 0) return { outcome: 'not_applied', saved }
    return { outcome: 'changed', saved }
  } catch {
    return { outcome: 'unknown' }
  }
}

/**
 * After an uncertain write, read what was actually saved and say what can be said.
 *
 * The status alone proves nothing about OUR request: another user may have made the same transition. What only our
 * request can produce is a `status_changed` activity row authored by us, leaving `previousStatus`, newer than the
 * task state we last saw. That is the best evidence available WITHOUT changing the database, and it has a limit
 * that cannot be removed here: it identifies "an action of ours", not "this request". A second tab of the same
 * person, or an earlier attempt, writes an identical row. Exact attribution needs a request id carried through the
 * protected RPC onto the activity row; until then the callers treat even `applied` as "saved under your name, not
 * confirmed as this request" and never resend.
 *
 *   status = expected, exactly one row of ours -> applied      (consistent with ours)
 *   status = expected, none or several         -> unattributed (do not claim it)
 *   status = previous, none                    -> not_applied  (nothing found; the person may try again)
 *   anything else                              -> changed
 *
 * A first answer of `unattributed` / `not_applied` is read once more after `recheckMs`, in case the write landed
 * just before the read and is not visible yet. This only reads — it never writes and never re-sends the mutation.
 */
export async function reconcileSavedStatus(
  supabase: SupabaseClient,
  taskId: string,
  spec: ReconcileSpec,
  opts: ReconcileOptions = {},
): Promise<Reconciled> {
  const first = await readOnce(supabase, taskId, spec)
  const wait = opts.recheckMs ?? 700
  if (wait <= 0 || (first.outcome !== 'unattributed' && first.outcome !== 'not_applied')) return first
  await new Promise(r => setTimeout(r, wait))
  const second = await readOnce(supabase, taskId, spec)
  return second.outcome === 'unknown' ? first : second
}
