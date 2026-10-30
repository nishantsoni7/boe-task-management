'use client'

// The signed-in person's PIs returned to Sales, for the Modules launcher's For
// you card (20270507000000). Not while previewing someone with View As: the
// read is the signed-in person's own (auth.uid()), so it would show the admin's
// PIs under someone else's name. A database without the function answers [].

import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { useSignedInUserId } from '@/hooks/queries/usePermissionContext'
import { useDisplaySubject } from '@/hooks/queries/useDisplaySubject'
import { isDashboardFunctionMissing } from '@/lib/orders/salespersonDashboard'
import { readReturnedPis, type ReturnedPi } from '@/lib/orders/returnedPis'

export const RETURNED_PIS_KEY = ['returned-pis'] as const

export function useMyReturnedPis(enabled: boolean) {
  const { data: userId } = useSignedInUserId()
  const { viewMode } = useDisplaySubject()
  return useQuery<ReturnedPi[]>({
    queryKey: [...RETURNED_PIS_KEY, userId ?? null],
    enabled: enabled && !!userId && !viewMode,
    queryFn: async () => {
      const { data, error } = await createClient().rpc('my_returned_pis')
      if (isDashboardFunctionMissing(error)) return []
      if (error) throw new Error(error.message || 'Could not load the PIs returned to you.')
      return readReturnedPis(data)
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}
