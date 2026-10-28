'use client'

import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { isValidUUID } from '@/lib/ui'
import { normalizeStoredTaskOrder } from '@/lib/tasks/taskOrder'

/** The cache entry, so the page and the save agree on one key. Keyed by the signed-in user. */
export const taskOrderKey = (userId: string | null | undefined) =>
  ['task-order', userId ?? null] as const

export const TASK_ORDER_TABLE = 'user_task_order'

/**
 * The person's drag-and-drop My Tasks order (task ids, first first), or null
 * when they have never saved one. A failed read is also null: the list must
 * still render, in its default order. RLS (`auth.uid() = user_id`) does the
 * enforcing; a stored id grants no access to a task.
 */
export function useTaskOrder(userId: string | null | undefined) {
  return useQuery<string[] | null>({
    queryKey: taskOrderKey(userId),
    enabled: isValidUUID(userId),
    queryFn: async () => {
      if (!isValidUUID(userId)) return null
      const { data, error } = await createClient()
        .from(TASK_ORDER_TABLE)
        .select('task_ids')
        .eq('user_id', userId)
        .maybeSingle()
      if (error) return null
      return normalizeStoredTaskOrder((data as { task_ids?: unknown } | null)?.task_ids)
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })
}
