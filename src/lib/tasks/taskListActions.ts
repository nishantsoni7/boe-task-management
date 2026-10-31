// Approve and Cancel from the Assigned By Me row.
//
// The same two writes Task Detail sends, with the same rules for a failure: the
// database's refusal is shown, a lost answer is read back rather than sent again,
// and nothing is claimed that the saved row cannot support. Task Detail keeps its
// own copy of the call on purpose: it also holds busy flags and an "uncertain" lock
// that a list row has no use for, and taskDetailLoad.test.ts pins it in place. The
// rules themselves are shared, all of them from taskDetailLoad.ts.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Task } from '@/lib/types'
import {
  classifyWriteFailure, isStateConflict, reconcileSavedStatus, recoveryMessage, WRITE_TIMEOUT_MS,
} from '@/lib/tasks/taskDetailLoad'

type ListTask = Pick<Task, 'id' | 'status' | 'created_at' | 'last_update_at'>

export type ListActionResult =
  /** The server answered that it is done. */
  | { kind: 'done' }
  /**
   * Nothing to celebrate: `message` says what happened, and `refresh` is true when
   * the list may now be out of date and has to be read again.
   */
  | { kind: 'stopped'; message: string; refresh: boolean }

const specFor = (task: ListTask, actorId: string, expectedStatus: string) => ({
  actorId,
  expectedStatus,
  previousStatus: task.status,
  since: task.last_update_at ?? task.created_at,
})

export async function approveTaskFromList(
  supabase: SupabaseClient,
  task: ListTask,
  actorId: string,
): Promise<ListActionResult> {
  let rpc: { error: { message: string; code?: string | null } | null }
  try {
    rpc = await supabase.rpc('transition_task_review', {
      p_task_id: task.id,
      p_action:  'approve',
      p_note:    null,
    }).abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS))
  } catch (e) {
    rpc = { error: { message: e instanceof Error ? e.message : 'Network error', code: null } }
  }
  const { error } = rpc
  if (!error) return { kind: 'done' }

  console.error('[approveTaskFromList] rpc failed:', error.message)
  const readable = (error.message.includes(':')
    ? error.message.slice(error.message.indexOf(':') + 1).trim()
    : error.message) || 'Failed to approve this task. Please try again.'
  const decided = classifyWriteFailure(error) === 'rejected'
  if (decided && !isStateConflict(error)) return { kind: 'stopped', message: readable, refresh: false }

  const settled = await reconcileSavedStatus(supabase, task.id, specFor(task, actorId, 'completed'))
  if (settled.outcome === 'unknown') {
    return decided
      ? { kind: 'stopped', message: readable, refresh: false }
      : {
          kind: 'stopped',
          message: 'The connection dropped and we could not confirm whether this task was approved. Open the task to check before trying again.',
          refresh: true,
        }
  }
  if (settled.outcome === 'not_applied') {
    return { kind: 'stopped', message: recoveryMessage('not_applied', task.status), refresh: false }
  }
  return { kind: 'stopped', message: recoveryMessage(settled.outcome, settled.saved.status), refresh: true }
}

export async function cancelTaskFromList(
  supabase: SupabaseClient,
  task: ListTask,
  actorId: string,
  reason: string,
  actorName: string | null | undefined,
): Promise<ListActionResult> {
  let res: Response | null = null
  try {
    res = await fetch('/api/cancel-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: task.id, reason, actorName }),
    })
  } catch (e) {
    console.error('[cancelTaskFromList] request failed:', e)
  }

  if (!res) {
    // No answer: read what was saved rather than inviting a second cancel.
    const settled = await reconcileSavedStatus(supabase, task.id, specFor(task, actorId, 'cancelled'))
    if (settled.outcome === 'unknown') {
      return {
        kind: 'stopped',
        message: 'The connection dropped and we could not confirm whether the task was cancelled. Open the task to check before trying again.',
        refresh: true,
      }
    }
    if (settled.outcome === 'not_applied') {
      return { kind: 'stopped', message: recoveryMessage('not_applied', task.status), refresh: false }
    }
    return { kind: 'stopped', message: recoveryMessage(settled.outcome, settled.saved.status), refresh: true }
  }

  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: 'Unknown error' }))
    return { kind: 'stopped', message: `Failed to cancel task: ${error}`, refresh: false }
  }
  return { kind: 'done' }
}
