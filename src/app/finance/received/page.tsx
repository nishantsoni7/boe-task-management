'use client'

// ── /finance/received — Confirmed Payments ─────────────────────────────────────
//
// THE TAB STRIP IS RETIRED. Requirement 1 (20261011000000) replaced the old
// `?view=all|orders|pi_drafts|available` sidebar/tab UI with the in-page
// allocation-status filter bar over `confirmed_allocation_status` (All / Zero
// / Partially / Fully Allocated — a real database predicate, in
// ReceivedPaymentsView itself). Nothing in this app can SET `?view=` any more.
//
// `?view=` ITSELF IS STILL READ, on purpose: an existing bookmark or saved
// link carrying it must not 404 or silently misbehave, and readPaymentView
// fails closed to 'all' for anything it does not recognise. It no longer
// narrows the query (paymentViewFilterClauses is gone from the loader), so at
// most it affects which of VIEW_META's page-title strings is shown — never
// which rows are returned.
//
// DEEP LINKS STILL ARRIVE HERE from the Admin Action Queue and from Finance
// notifications, and the list resolves the row by id when it is not on the
// current page. The attachment action is `?action=allocate`, and that is the
// only value that opens Allocate Funds — `link` was retired with the workflow
// and is NOT an alias for it: an unrecognised action lands on the ordinary
// list rather than being reinterpreted as a different one.

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { LoadingScreen } from '@/components/ui/atoms'
import { readPaymentView } from '@/lib/finance/paymentClassification'
import { ReceivedPaymentsView } from './ReceivedPaymentsView'

export default function ReceivedPaymentsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <ReceivedPayments />
    </Suspense>
  )
}

function ReceivedPayments() {
  const searchParams = useSearchParams()
  // Anything unrecognised — an old bookmark, a typed URL — resolves to All
  // rather than to an empty list.
  return <ReceivedPaymentsView view={readPaymentView(searchParams.get('view'))} />
}
