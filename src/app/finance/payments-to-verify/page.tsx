'use client'

// ── /finance/payments-to-verify — the half that is not money yet ──────────────
//
// WHY THIS IS A ROUTE AND NOT A FILTER
//
// The two halves of the payments table are different work for different people.
// A verifier opens this page to DECIDE something; everybody else opens Confirmed
// Payments to read money that has actually arrived. They were one list, and that
// cost both audiences:
//
//   * every count, every search result and every page number was computed over a
//     set that mixed the two, so "142 payments" answered neither question;
//   * a verifier scanned past confirmed rows to find the three that needed them;
//   * the four classification views — All, Orders, PI Drafts, Available to
//     Allocate — were offered over money nobody had confirmed arrived, and
//     "Available to Allocate" over an unverified payment is an invitation to
//     spend it twice.
//
// WHICH STATUSES, and the answer is the database's. finance_payment_requests.status
// admits five values (20260628000200), and
// public.finance_payment_status_is_verified() — 20260918000000 §5, which calls
// itself "the single definition of verified" — names two of them as confirmed.
// This page is the other three: pending_approval, needs_clarification and
// rejected. The split is disjoint and exhaustive, and paymentSurfaces.ts is
// where both halves are written down once.
//
// REJECTED MONEY IS HERE, and not on Confirmed Payments. It is not money, so it
// classifies nowhere and belongs in no allocation view; but it IS a decision
// somebody made about a submission, and a verifier looking for what happened to
// a payment needs to find it. Hiding it entirely would make the page lie about
// its own scope.
//
// THE ACTIONS DO NOT MOVE. Verification stays here, where the rows are. A row
// leaves this page the moment it is verified and appears on Confirmed Payments,
// because both pages ask the database for their own statuses rather than
// filtering a shared list in the browser.

import { Suspense } from 'react'
import { LoadingScreen } from '@/components/ui/atoms'
import { ReceivedPaymentsView } from '../received/ReceivedPaymentsView'

export default function PaymentsToVerifyPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      {/*
        NO `view` FROM THE QUERY STRING. The four classification views belong to
        Confirmed Payments; passing one here would let a bookmark narrow this
        page by an attribution that cannot exist yet. 'all' is the only honest
        value, and surfaceHasClassificationViews() stops it being applied at all.
      */}
      <ReceivedPaymentsView view="all" surface="to_verify" />
    </Suspense>
  )
}
