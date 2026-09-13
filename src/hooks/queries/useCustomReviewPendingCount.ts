import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'

// The number beside "Custom Submissions" in the Review Workflow sidebar: custom
// reviews waiting for a decision — status pending_verification, and nothing
// else. Approved rows, rejected rows waiting on the employee, and generated
// reviews are not in it.
//
// FOR VERIFIERS ONLY. `enabled` is the viewer's resolved `verify`; a candidate
// never asks, and the badge is drawn only on a verifier-only entry. The count
// is read through the caller's own RLS, which gives a verifier every row — the
// same set the Custom Submissions queue lists — so the badge and the queue
// cannot disagree about who is waiting.
//
// head: true — one cheap count, no rows. One query key, so every sidebar mount
// shares one fetch (TanStack dedupes), stale after 30 seconds like every other
// nav count in BOE. A decision, a submission or a reapplication made in this
// tab invalidates the key, so the number moves at once; a colleague's action
// arrives on the next read after the 30 seconds.
export const CUSTOM_REVIEW_PENDING_COUNT_KEY = ['customer-reviews', 'custom-submissions', 'pending-count'] as const

/** `undefined` while unknown, when disabled, or if the read was refused — render no badge. */
export function useCustomReviewPendingCount(enabled: boolean): number | undefined {
  const { data } = useQuery({
    queryKey: CUSTOM_REVIEW_PENDING_COUNT_KEY,
    enabled,
    queryFn: async () => {
      const supabase = createClient()
      const result = await supabase
        .from('customer_review_custom_submissions')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending_verification')
      // A refusal is not a zero.
      return result.error ? null : (result.count ?? 0)
    },
    staleTime: 30 * 1000,
  })
  return enabled && typeof data === 'number' ? data : undefined
}
