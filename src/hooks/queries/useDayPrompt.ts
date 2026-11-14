'use client'

// The Day Close strip's answer for the signed-in person (owner, 2026-11-12): file the plan / close the
// day. The server decides; this fetches it again every two minutes while the Modules page is open.
// A failed read is no answer: the page draws nothing rather than a guess.

import { useQuery } from '@tanstack/react-query'
import { batchedGet } from '@/components/dayClose/batchedGet'
import type { DayPrompt } from '@/lib/dayClose/rules'

export type DayPromptAnswer = { today: string; prompt: DayPrompt; counts?: { open: number } }

export function useDayPrompt(userId: string | null, enabled: boolean) {
  return useQuery<DayPromptAnswer>({
    queryKey: ['day-close-prompt', userId],
    enabled: enabled && !!userId,
    queryFn: async () => {
      // Asked together with the score, vote and Star Seller cards as ONE request (batchedGet.ts).
      const r = await batchedGet('/api/day-close/prompt')
      if (r.status < 200 || r.status >= 300) throw new Error(`day prompt ${r.status}`)
      return r.body as unknown as DayPromptAnswer
    },
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false,
  })
}
