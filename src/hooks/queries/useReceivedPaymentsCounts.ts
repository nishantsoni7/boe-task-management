import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { RECEIVED_PAYMENTS_SOURCE } from '@/app/finance/paymentRouting'
import {
  CLASSIFIED_PAYMENT_STATUSES,
  PAYMENT_VIEWS,
  paymentViewClauses,
  type PaymentView,
} from '@/lib/finance/paymentClassification'

// Neutral volume counts for the Finance sidebar's four Received Payments
// entries — All, Orders, PI Drafts and Available.
//
// EVERY NUMBER COMES FROM THE SAME THREE SOURCES OF TRUTH THE PAGE ITSELF USES:
// RECEIVED_PAYMENTS_SOURCE for the rows, CLASSIFIED_PAYMENT_STATUSES for the
// status scope, and paymentViewClauses for the classification. None of the three
// is retyped here, so a badge cannot describe a different set from the tab it
// sits beside — the alignment is structural, not a comment asking two call sites
// to stay in step.
//
//   All        every payment that is not rejected
//   Orders     is_linked_to_order
//   PI Drafts  is_linked_to_pi
//   Available  is_available_to_allocate
//
// THE FOUR ARE NOT A PARTITION AND THEIR COUNTS DO NOT SUM TO "All". A payment
// split between an Order and a PI Draft with money left over is counted in
// THREE of them, because it is genuinely in all three — that is what a
// classification of connections means, as opposed to a bucket each payment falls
// into. Anyone reading these as a breakdown would be reading them wrong, which
// is why they sit beside their own tabs rather than in one summary line.
//
// THE CLASSIFICATION IS THE PROJECTION'S, computed under the canonical
// attribution rule: an active allocation is authoritative, the payment's own
// order_id is the fallback only when there is none, and a reversed allocation
// counts for nothing. Reading the base table's columns here would count money
// that final PI approval has already moved onto a numbered Order — the
// allocation moves, the payment record deliberately does not
// (20260921000000 §7) — and it would count money parked on a retired Order
// Request as spoken for when nothing will ever come to collect it.
//
// Rejected payments are excluded twice over: by the status scope here, and by
// the projection's own booleans, which are false for a rejected row whatever its
// figures say.
//
// head: true — the server returns the count and NO rows, so this stays four
// cheap queries however large the ledger grows. RLS applies to the count exactly
// as it applies to the lists, so each viewer's badge matches the page they can
// open: the projection is security_invoker, so every underlying policy is still
// evaluated as the caller and a count can never exceed what they may read.
//
// One query key holds all four: they are read together, invalidated together,
// and can never be one refresh apart.
export const RECEIVED_PAYMENTS_COUNTS_KEY = ['finance', 'received-payments', 'counts'] as const

/** `undefined` only while the first fetch is in flight — see the note below. */
export type ReceivedPaymentsCounts = Record<PaymentView, number | undefined>

const PENDING: ReceivedPaymentsCounts = {
  all: undefined, orders: undefined, pi_drafts: undefined, available: undefined,
}

export function useReceivedPaymentsCounts(): ReceivedPaymentsCounts {
  const { data } = useQuery({
    queryKey: RECEIVED_PAYMENTS_COUNTS_KEY,
    queryFn: async () => {
      const supabase = createClient()

      // Rebuilt per call: a PostgREST builder is single-use, so the four scopes
      // cannot share one instance.
      const scopedFor = (view: PaymentView) => {
        let query = supabase
          .from(RECEIVED_PAYMENTS_SOURCE)
          .select('id', { count: 'exact', head: true })
          .in('status', CLASSIFIED_PAYMENT_STATUSES as unknown as string[])
        for (const clause of paymentViewClauses(view)) {
          if (clause.kind === 'eq') query = query.eq(clause.column, clause.value)
        }
        return query
      }

      const results = await Promise.all(PAYMENT_VIEWS.map(view => scopedFor(view)))

      const counts = { ...PENDING } as Record<PaymentView, number | undefined>
      PAYMENT_VIEWS.forEach((view, index) => {
        const result = results[index]
        // A REFUSAL IS NOT A ZERO. The classification columns arrive with
        // 20261008000000; against a database without them PostgREST refuses the
        // filter outright, and a badge reading "0" would say there is nothing
        // there when the truth is that nothing was asked. Left undefined, which
        // renders as no badge at all.
        counts[view] = result.error ? undefined : (result.count ?? 0)
      })
      return counts
    },
    staleTime: 30 * 1000,
  })

  // Returns undefined while the first fetch is in flight so the badges stay
  // blank rather than flashing a misleading "0"; once resolved each is a number,
  // including a genuine 0.
  return data ?? PENDING
}
