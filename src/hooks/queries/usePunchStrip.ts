'use client'

// The punch-in strip's answer for the signed-in person, for the Modules page.
// The server decides what to say and for how long; this only fetches it again
// every minute while the page is open, so a punch that has just reached BOE turns
// the red strip green by itself. (No refetch on window focus: the app switches it
// off everywhere, see financeRefreshPolicy.test.ts; a tab that was in the
// background catches up at its next minute.)
//
// A failed read is no answer: the page draws nothing rather than a guess.

import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import type { PunchStrip } from '@/lib/minop/punchStrip'

export function usePunchStrip(userId: string | null, enabled: boolean) {
  return useQuery<PunchStrip>({
    queryKey: ['punch-strip', userId],
    enabled: enabled && !!userId,
    queryFn: async () => {
      const { data: { session } } = await createClient().auth.getSession()
      const res = await fetch('/api/attendance/my-punch', {
        headers: { authorization: `Bearer ${session?.access_token ?? ''}` },
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`my punch ${res.status}`)
      return res.json()
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  })
}
