'use client'

// Whether the attendance machine is sending, for the Modules launcher's For you
// card. Admins only: the route refuses anybody else and `enabled` is false for
// them, so nobody else makes the request.

import { useQuery } from '@tanstack/react-query'
import { batchedGet } from '@/components/dayClose/batchedGet'
import type { MachineHealth } from '@/lib/minop/machineHealth'

export const MACHINE_HEALTH_KEY = ['machine-health'] as const

export function useMachineHealth(enabled: boolean) {
  return useQuery<MachineHealth>({
    queryKey: MACHINE_HEALTH_KEY,
    enabled,
    queryFn: async () => {
      // Asked beside the punch strip, the pending requests and the Day Close answers as ONE request
      // (src/components/dayClose/batchedGet.ts); alone it is this one route, fetched as it always was.
      const res = await batchedGet('/api/attendance/machine-status')
      if (res.status < 200 || res.status >= 300) throw new Error(`machine status ${res.status}`)
      return res.body as unknown as MachineHealth
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  })
}
