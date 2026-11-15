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
import { batchedGet } from '@/components/dayClose/batchedGet'
import type { PunchStrip } from '@/lib/minop/punchStrip'

export function usePunchStrip(userId: string | null, enabled: boolean) {
  return useQuery<PunchStrip>({
    queryKey: ['punch-strip', userId],
    enabled: enabled && !!userId,
    queryFn: async () => {
      // Asked beside the Day Close and Scoreboard answers (and, for an administrator, the machine's health
      // and the pending requests) as ONE request (src/components/dayClose/batchedGet.ts); alone it is this
      // one route, fetched as it always was.
      const res = await batchedGet('/api/attendance/my-punch')
      if (res.status < 200 || res.status >= 300) throw new Error(`my punch ${res.status}`)
      return res.body as unknown as PunchStrip
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  })
}
