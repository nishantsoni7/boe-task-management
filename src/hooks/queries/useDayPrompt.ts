'use client'

// The Day Close strip's answer for the signed-in person (owner, 2026-11-12): file the plan / close the
// day. The server decides; this fetches it again every two minutes while the Modules page is open.
// A failed read is no answer: the page draws nothing rather than a guess.

import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import type { DayPrompt } from '@/lib/dayClose/rules'

export type DayPromptAnswer = { today: string; prompt: DayPrompt; counts?: { open: number } }

export function useDayPrompt(userId: string | null, enabled: boolean) {
  return useQuery<DayPromptAnswer>({
    queryKey: ['day-close-prompt', userId],
    enabled: enabled && !!userId,
    queryFn: async () => {
      const { data: { session } } = await createClient().auth.getSession()
      const res = await fetch('/api/day-close/prompt', {
        headers: { authorization: `Bearer ${session?.access_token ?? ''}` },
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`day prompt ${res.status}`)
      return res.json()
    },
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false,
  })
}
