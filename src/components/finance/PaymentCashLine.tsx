'use client'

import { useState } from 'react'
import { usePaymentCustodyStatus } from '@/hooks/queries/useCashJourneys'
import { CashStateChip } from '@/components/finance/CashStateChip'
import { CashPaymentActions } from '@/components/finance/CashPaymentActions'
import { HandoverModal } from '@/components/finance/HandoverModal'

/**
 * Where ONE payment's money is, with its one action (Accept / Receive / Hand
 * over) and its journey — for the payment rows on the order and PI pages.
 *
 * Mounted only for PNB, Paytm and Canara rows. Draws nothing until the answer
 * arrives, and nothing at all for a payment the reader may not look at
 * (finance_payment_custody_status leaves it out).
 */
export function PaymentCashLine({ paymentId }: { paymentId: string }) {
  const q = usePaymentCustodyStatus([paymentId])
  const [handOverOpen, setHandOverOpen] = useState(false)
  const p = q.data?.get(paymentId)
  if (!p || !p.tracked) return null
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
      <CashStateChip payment={p} />
      <CashPaymentActions payment={p} onHandOver={() => setHandOverOpen(true)} />
      {handOverOpen && <HandoverModal onClose={() => setHandOverOpen(false)} />}
    </div>
  )
}
