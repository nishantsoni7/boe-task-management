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
  /** The saved row shows the write landed. */
  | { outcome: 'applied'; saved: SavedTaskState }
  /** The saved row still shows the status it had before: nothing was written. */
  | { outcome: 'not_applied'; saved: SavedTaskState }
  /** The row holds some third status — somebody else moved the task meanwhile. */
  | { outcome: 'changed'; saved: SavedTaskState }
  /** The row could not be read either, so nothing can be said. */
  | { outcome: 'unknown' }

/**
 * After an uncertain write, read what was actually saved. `expectedStatus` is
 * the status a successful write leaves; `previousStatus` the one it started
 * from. This reads — it never writes, and never re-sends the mutation.
 */
export async function reconcileSavedStatus(
  supabase: SupabaseClient,
  taskId: string,
  expectedStatus: string,
  previousStatus: string,
): Promise<Reconciled> {
  try {
    const { data, error } = await supabase.from('tasks').select(SAVED_STATE_COLUMNS).eq('id', taskId).single()
    if (error || !data) return { outcome: 'unknown' }
    const saved = data as unknown as SavedTaskState
    if (saved.status === expectedStatus) return { outcome: 'applied', saved }
    if (saved.status === previousStatus) return { outcome: 'not_applied', saved }
    return { outcome: 'changed', saved }
  } catch {
    return { outcome: 'unknown' }
  }
}
