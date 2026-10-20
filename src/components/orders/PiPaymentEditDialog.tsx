'use client'

// Opens Finance's own Edit Payment form from a payments popup (PI Draft page
// and Order page).
//
// THE FORMS ARE NOT COPIED. A payment still with Finance is corrected through
// the form and protected database door Finance already has, edit_payment_request,
// which refuses a verified payment and anyone who is neither the submitter nor
// an admin. A CONFIRMED payment is corrected through Finance's own confirmed
// payment form (received/receivedPaymentsEdit), whose guards (verified and
// allocation rules) are the database's. This file only reads the one row, picks
// the form by the payment's status and hands it over, so the page performs no
// table write of its own. A refusal is shown by the form itself.

import React, { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { EditPaymentModal } from '@/app/finance/paymentRequestsEdit'
import type { PaymentRequest } from '@/app/finance/paymentRequestsModel'
import { EditPaymentModal as EditConfirmedPaymentModal } from '@/app/finance/received/receivedPaymentsEdit'
import type { PaymentRequest as ConfirmedPaymentRequest } from '@/app/finance/received/receivedPaymentsModel'
import { isAwaitingVerification, isConfirmedPayment } from '@/lib/finance/piPaymentView'

type Props = {
  supabase: ReturnType<typeof createClient>
  paymentId: string
  isAdmin: boolean
  /** Closed without saving, or the payment could not be read. */
  onClose: () => void
  /** Saved: the caller re-reads its payments and shows the dialog again. */
  onSaved: () => void
}

export function PiPaymentEditDialog({ supabase, paymentId, isAdmin, onClose, onSaved }: Props) {
  const [request, setRequest] = useState<PaymentRequest | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    const run = async () => {
      const { data } = await supabase
        .from('finance_payment_requests')
        .select(`
          id, request_number, human_payment_id, client_name, amount, payment_date, payment_mode,
          received_in, collected_by_user_id, collected_from_text,
          handed_over_to_user_id, handed_over_at, collection_handover_note,
          proof_note, order_number, order_id,
          order_request_id, order_request_number, sales_note,
          payment_against, payment_target_type, status, submitted_by, admin_note, created_at,
          updated_at, rejected_at, clarification_requested_at
        `)
        .eq('id', paymentId)
        .maybeSingle()
      if (!active) return
      if (data) setRequest(data as unknown as PaymentRequest)
      else setFailed(true)
    }
    void run()
    return () => { active = false }
  }, [supabase, paymentId])

  useEffect(() => {
    if (failed) onClose()
  }, [failed, onClose])

  const awaiting = request !== null && isAwaitingVerification(request.status)
  const confirmed = request !== null && isConfirmedPayment(request.status)
  const correctable = awaiting || confirmed

  // A rejected or otherwise uncorrectable payment is closed again, not edited.
  useEffect(() => {
    if (request && !correctable) onClose()
  }, [request, correctable, onClose])

  if (!request || !correctable) return null
  if (confirmed) {
    return (
      <EditConfirmedPaymentModal
        request={request as unknown as ConfirmedPaymentRequest}
        supabase={supabase}
        onClose={onClose}
        onSaved={onSaved}
      />
    )
  }
  return (
    <EditPaymentModal
      request={request}
      isAdmin={isAdmin}
      supabase={supabase}
      onClose={onClose}
      onSaved={onSaved}
    />
  )
}
