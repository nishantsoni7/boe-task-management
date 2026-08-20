import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import {
  CONFIRMED_PAYMENT_STATUSES,
  RECEIVED_PAYMENTS_SOURCE,
  applyLinkageScope,
} from '@/app/finance/paymentRouting'

// Neutral volume counts for the Finance sidebar's two Received Payments entries.
//
// Both numbers come from the SAME three sources of truth the pages themselves
// use: RECEIVED_PAYMENTS_SOURCE for the rows, CONFIRMED_PAYMENT_STATUSES for the
// status scope, and applyLinkageScope for the linkage split. None of the three is
// retyped here, so a badge cannot describe a different set from the page it sits
// beside — the alignment is structural, not a comment asking two call sites to
// stay in step.
//
//   Linked     → status IN (approved_unlinked, approved_linked)
//                AND (is_order_allocated OR order_id IS NOT NULL
//                     OR order_request_id IS NOT NULL)
//   Non-Linked → status IN (approved_unlinked, approved_linked)
//                AND NOT is_order_allocated AND order_id IS NULL
//                AND order_request_id IS NULL
//
// is_order_allocated is the projection's ACTIVE-allocation flag: money moved onto
// a Confirmed Order at PI approval leaves the parent payment untouched, so this
// is the only column that tells the truth about it. Reading the base table here
// would count that money as unallocated and print a Non-Linked badge for a queue
// that has nothing left to action.
//
// Request-stage records (pending_approval, needs_clarification, rejected) are
// excluded by the status scope, so nothing still awaiting a decision is ever
// counted as money received.
//
// head: true — the server returns the count and NO rows, so this stays two cheap
// queries however large the ledger grows. RLS applies to the count exactly as it
// applies to the lists, so each viewer's badge matches the page they can open —
// the projection is security_invoker, so every underlying policy is still
// evaluated as the caller and the count can never exceed what they may read.
//
// One query key holds both numbers: they are read together, invalidated
// together, and can never be one refresh apart.
export const RECEIVED_PAYMENTS_COUNTS_KEY = ['finance', 'received-payments', 'counts'] as const

export type ReceivedPaymentsCounts = {
  /** undefined only while the first fetch is in flight — see the note below. */
  linked:   number | undefined
  unlinked: number | undefined
}

export function useReceivedPaymentsCounts(): ReceivedPaymentsCounts {
  const { data } = useQuery({
    queryKey: RECEIVED_PAYMENTS_COUNTS_KEY,
    queryFn: async () => {
      const supabase = createClient()
      // Rebuilt per call: a PostgREST builder is single-use, so the two scopes
      // cannot share one instance.
      const scoped = () => supabase
        .from(RECEIVED_PAYMENTS_SOURCE)
        .select('id', { count: 'exact', head: true })
        .in('status', CONFIRMED_PAYMENT_STATUSES as unknown as string[])

      const [linkedRes, unlinkedRes] = await Promise.all([
        applyLinkageScope(scoped(), 'linked'),
        applyLinkageScope(scoped(), 'unlinked'),
      ])

      return {
        linked:   linkedRes.count   ?? 0,
        unlinked: unlinkedRes.count ?? 0,
      }
    },
    staleTime: 30 * 1000,
  })

  // Returns undefined while the first fetch is in flight so the badges stay
  // blank rather than flashing a misleading "0"; once resolved both are always
  // numbers, including a genuine 0.
  return { linked: data?.linked, unlinked: data?.unlinked }
}
