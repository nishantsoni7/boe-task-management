// The order My Tasks lists a person's tasks in.
//
//   1. Important (starred) tasks
//   2. Today's Focus pins
//   3. everything else
//
// Inside each group, the person's own drag-and-drop order (public.user_task_order,
// migration 20270424000000) decides; a task they have never placed keeps the
// order the list already had and sits after the ones they have.
//
// PURE: no clock, no network. The page feeds it, the tests call it directly.

import type { Task } from '@/lib/types'

/** Same ceiling as the database check on user_task_order.task_ids. */
export const TASK_ORDER_MAX = 1000

export type TaskGroup = 0 | 1 | 2

/** 0 = Important, 1 = pinned, 2 = the rest. A finished task is never Important. */
export function taskGroup(task: Pick<Task, 'is_urgent' | 'status'>, pinned: boolean): TaskGroup {
  if (task.is_urgent && task.status !== 'completed') return 0
  return pinned ? 1 : 2
}

export function sortMyTasks<T extends Pick<Task, 'id' | 'is_urgent' | 'status'>>(
  tasks: readonly T[],
  pinnedIds: ReadonlySet<string> | undefined,
  savedOrder: readonly string[] | null | undefined,
): T[] {
  const rank = new Map<string, number>()
  ;(savedOrder ?? []).forEach((id, i) => { if (!rank.has(id)) rank.set(id, i) })
  return tasks
    .map((task, index) => ({ task, index, group: taskGroup(task, !!pinnedIds?.has(task.id)) }))
    .sort((a, b) => {
      if (a.group !== b.group) return a.group - b.group
      const ra = rank.get(a.task.id)
      const rb = rank.get(b.task.id)
      if (ra !== undefined && rb !== undefined) return ra - rb
      if (ra !== undefined) return -1
      if (rb !== undefined) return 1
      return a.index - b.index
    })
    .map(x => x.task)
}

/**
 * The new saved order after `fromId` is dropped onto `toId`. `fullOrderIds` is
 * EVERY task of the list in its current sorted order (not just the rows a tab
 * or filter shows), so the move lands correctly in whichever view the person
 * opens next. Returns null when nothing should change: the same task, an id
 * that is not in the list, or a drop across groups (Important / pinned / rest
 * are decided by the star and the pin, not by dragging).
 */
export function reorderAfterDrop(
  fullOrderIds: readonly string[],
  fromId: string,
  toId: string,
  groupOf: (id: string) => TaskGroup | undefined,
): string[] | null {
  if (fromId === toId) return null
  const from = fullOrderIds.indexOf(fromId)
  const to = fullOrderIds.indexOf(toId)
  if (from < 0 || to < 0) return null
  if (groupOf(fromId) !== groupOf(toId)) return null
  const next = fullOrderIds.slice()
  next.splice(from, 1)
  next.splice(to, 0, fromId)
  return next.slice(0, TASK_ORDER_MAX)
}

/** Accepts only what the column can legally hold; anything else is "no saved order". */
export function normalizeStoredTaskOrder(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of value) {
    if (typeof v !== 'string' || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out.length > 0 ? out.slice(0, TASK_ORDER_MAX) : null
}
