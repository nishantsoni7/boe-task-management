'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { useControlCenterSession } from '@/components/layout/ControlCenterContext'
import { loadActionQueue, type ActionQueueResult } from '@/lib/controlCenter/actionQueue'
import { CONTROL_CENTER_STALE_MS } from '@/hooks/queries/useControlCenterData'

// The Action Queue, as the Control Center's Home reads it: the same rows the
// full queue page lists (one loader, src/lib/controlCenter/actionQueue.ts),
// cached for the same window as the rest of the Control Center's reads. The key
// carries the signed-in user's id so an entry is never addressable by another.
export const actionQueueKey = (userId: string) => ['control-center', 'action-queue', userId] as const

export function useActionQueue() {
  const { userId } = useControlCenterSession()
  const supabase = useMemo(() => createClient(), [])
  return useQuery<ActionQueueResult>({
    queryKey: actionQueueKey(userId),
    queryFn: () => loadActionQueue(supabase),
    staleTime: CONTROL_CENTER_STALE_MS,
  })
}
