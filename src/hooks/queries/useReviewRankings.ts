'use client'

import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { REVIEW_RANKINGS_KEY, readRankingsVisible } from '@/lib/customerReviews/rankingsSwitch'

// Whether the review ranking is switched on (20270702000000). Read under RLS by any
// signed-in employee; written only by set_review_rankings_visible(), which refuses
// anyone but an administrator. See src/lib/customerReviews/rankingsSwitch.ts.
//
// FAILS CLOSED. `visible` is true only once the database has said so: while it loads,
// if the read fails, or if the table does not exist yet, it is false. `failed` lets the
// Control Center screen refuse to show a switch it could not read.

export type RankingsRead = { visible: boolean; failed: boolean }

export function useReviewRankings() {
  const query = useQuery<RankingsRead>({
    queryKey: REVIEW_RANKINGS_KEY,
    queryFn: async () => {
      const { data, error } = await createClient().from('review_display_settings').select('rankings_visible').maybeSingle()
      return error ? { visible: false, failed: true } : { visible: readRankingsVisible(data), failed: false }
    },
    staleTime: 30_000,
  })
  return {
    visible: query.data?.visible === true,
    /** False until the switch has been read; the screens draw nothing for the ranking before then. */
    known: !query.isPending,
    failed: query.data?.failed === true,
  }
}

export type RankingsSave = { ok: true } | { ok: false; message: string }

/** Control Center: the one write, refused to non-admins by the database. */
export async function saveRankingsVisible(visible: boolean): Promise<RankingsSave> {
  const { error } = await createClient().rpc('set_review_rankings_visible', { p_visible: visible })
  return error ? { ok: false, message: error.message || 'Could not save that change.' } : { ok: true }
}
