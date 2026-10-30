'use client'

// Whether the attendance machine is sending, for the Modules launcher's For you
// card. Admins only: the route refuses anybody else and `enabled` is false for
// them, so nobody else makes the request.

import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import type { MachineHealth } from '@/lib/minop/machineHealth'

export const MACHINE_HEALTH_KEY = ['machine-health'] as const

export function useMachineHealth(enabled: boolean) {
  return useQuery<MachineHealth>({
    queryKey: MACHINE_HEALTH_KEY,
    enabled,
    queryFn: async () => {
      const { data: { session } } = await createClient().auth.getSession()
      const res = await fetch('/api/attendance/machine-status', {
        headers: { authorization: `Bearer ${session?.access_token ?? ''}` },
      })
      if (!res.ok) throw new Error(`machine status ${res.status}`)
      return res.json()
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  })
}
