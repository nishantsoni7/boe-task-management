'use client'

// ── /finance/received — the payments surface ──────────────────────────────────
//
// ONE LIST, FOUR VIEWS. Received Payments used to be two sibling routes, Linked
// and Non-Linked, splitting every payment by whether any of three columns was
// set. That split could not survive the canonical classification:
//
//   * a payment divided between a Confirmed Order and a PI Draft belongs in BOTH
//     linked views at once, and in Available too if anything is left over — three
//     memberships a two-page partition cannot express;
//   * an Order Request linkage counted as "linked", on the reasoning that
//     conversion would move the money onto an Order by itself. The workflow is
//     retired (20261007000000), nothing will convert, and the canonical rule has
//     never attributed a rupee through that column — so the money was displayed
//     as spoken for while every figure beside it said it was free.
//
// The view is a `?view=` on this one route, so a payment can appear in as many
// of them as it genuinely belongs to, and every narrowing and count is the
// database's rather than a filter over the page in hand.
//
// DEEP LINKS ARE UNCHANGED. `?payment=…&action=link|edit` still arrives here from
// the Admin Action Queue and from Finance notifications, and still opens the
// same modal it always did — the list resolves the row by id when it is not on
// the current page, so it no longer matters which view the reader lands in.

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
