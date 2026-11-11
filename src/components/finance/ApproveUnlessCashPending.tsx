'use client'

import { usePaymentCustodyStatus } from '@/hooks/queries/useCashJourneys'
import { CONFIRMED_WHEN_CASH_ARRIVES, awaitsCompanyCash } from '@/lib/finance/cashJourney'

/**
 * Wraps the Verify / Approve control of a PNB, Paytm or Canara payment row
 * (20270612000000). While the payment's cash is known NOT to be with the company the
 * control is replaced by the sentence that says when it is confirmed; the
 * database refuses the verification anyway. Unknown (still loading, not readable)
 * keeps the control, so a closed payment is never left without one.
 */
export function ApproveUnlessCashPending({ paymentId, children }: { paymentId: string; children: React.ReactNode }) {
  const p = usePaymentCustodyStatus([paymentId]).data?.get(paymentId)
  if (awaitsCompanyCash(p?.paymentMode, p)) {
    return <span className="pi-pay-sub">{CONFIRMED_WHEN_CASH_ARRIVES}</span>
  }
  return <>{children}</>
}
