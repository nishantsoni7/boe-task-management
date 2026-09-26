// ── The last call of every "Record payment" action ────────────────────────────
//
// complete_payment_entry (20270120000000) is called once a payment is recorded
// AND its proof, if any, is attached. For somebody holding the protected
// finance.verify_own_payment authority (granted in Control Center; an admin
// holds it through the admin branch) it verifies their own pending payment
// through the one verification door and tells the other holders, for
// information only. For everybody else it changes nothing, and the payment
// waits for verification exactly as before.
//
// WHY AFTER THE PROOF. A proof can be attached only while its payment is
// pending (payment_proof_attachments_insert and the payment-proofs storage
// policy). Verifying first would leave an Admin's payment unable to carry it.
//
// NOTHING HERE DECIDES WHO MAY ACT: the database does, from the grant. A failed
// or unanswered call resolves to "not verified" — the truthful fallback, since
// the payment is then simply pending and its holder may verify it themselves.

type CompletionClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>
}

export type PaymentEntryCompletion = { verified: boolean }

export async function completePaymentEntry(
  client: CompletionClient,
  paymentRequestId: string | null | undefined,
): Promise<PaymentEntryCompletion> {
  if (!paymentRequestId) return { verified: false }
  try {
    const { data, error } = await client.rpc('complete_payment_entry', { p_request_id: paymentRequestId })
    if (error || !data) return { verified: false }
    return { verified: (data as { verified_on_entry?: unknown }).verified_on_entry === true }
  } catch {
    return { verified: false }
  }
}

/** What the recorder reads when their own payment was verified in the same action. */
export const PAYMENT_RECORDED_AND_VERIFIED_BODY =
  'You may verify your own payments, so it is recorded and verified now and counts toward the 40% advance. The other Admins have been told, for information.'
